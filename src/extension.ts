import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StataTerminal, type RunTarget, type StataErrorEvent } from './stataTerminal';
import { GraphPanel } from './graphPanel';
import { DataPanel } from './dataPanel';
import { VariablesPanel } from './variablesPanel';
import { DatasetPanel } from './datasetPanel';
import { StoredResultsPanel } from './storedResultsPanel';
import { PlotsListPanel } from './plotsListPanel';
import { StataCompletionProvider } from './completionProvider';
import { StataHoverProvider } from './hoverProvider';
import { StataLinkProvider } from './linkProvider';
import { StataOutlineProvider } from './outlineProvider';
import { StataDefinitionProvider } from './definitionProvider';
import { getStataPathDiagnostics, getBackendDiagnostics, resolveBackend, type BackendDiagnostics } from './config';
import { stataQuote } from './stataCode';
import { registerSthlpViewer } from './sthlpViewer';

let stataTerminal: StataTerminal | undefined;
let terminal: vscode.Terminal | undefined;
let graphPanel: GraphPanel | undefined;
let dataPanel: DataPanel | undefined;
let statusBarItem: vscode.StatusBarItem;
let busyStatusItem: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;

// Sidebar panels (created once in activate, persist across terminal sessions)
let datasetPanel: DatasetPanel;
let variablesPanel: VariablesPanel;
let storedResultsPanel: StoredResultsPanel;
let plotsListPanel: PlotsListPanel;
let datasetVariables: string[] = [];

function readVariableNames(varsPath: string): string[] {
    try {
        return fs.readFileSync(varsPath, 'utf-8').split(/\r?\n/).slice(1)
            .map((line) => line.split('\t')[0]).filter(Boolean);
    } catch {
        return [];
    }
}

function updateStataTerminalFocus(): void {
    void vscode.commands.executeCommand('setContext', 'stata.terminalFocused',
        !!terminal && vscode.window.activeTerminal === terminal);
}

async function formatPathDiagnostics(diagnostics = getStataPathDiagnostics(), backend?: BackendDiagnostics): Promise<string> {
    backend ??= await getBackendDiagnostics(diagnostics.selectedPath);
    const lines = [
        'Stata Path Diagnostics',
        `Platform: ${diagnostics.platform}`,
        `Preferred edition: ${diagnostics.edition}`,
        `Configured stata.stataPath: ${diagnostics.configuredPath || '(empty)'}`,
        `Resolved configured path: ${diagnostics.resolvedConfiguredPath || '(not resolved)'}`,
        `Selected path: ${diagnostics.selectedPath || '(none)'}`,
        `Backend: ${backend.backend} (stata.backend: ${backend.configuredBackend})`,
        `Install directory: ${backend.installDir || '(not resolved)'}`,
        `utilities/pystata exists: ${backend.pystataExists ? 'yes' : 'no'}`,
        `Python path: ${backend.python?.path || '(not found)'}`,
        `Python version: ${backend.python ? `${backend.python.version} (${backend.python.bits}-bit)` : '(unknown)'}`,
        ...(backend.error ? [`Python discovery: ${backend.error}`] : []),
        '',
        'PATH matches:',
        ...(diagnostics.pathMatches.length > 0 ? diagnostics.pathMatches.map((match) => `  ${match}`) : ['  (none)']),
        '',
        'Detected install candidates on disk:',
        ...(diagnostics.existingCandidates.length > 0 ? diagnostics.existingCandidates.map((candidate) => `  ${candidate}`) : ['  (none)']),
        '',
        `Help: ${diagnostics.helpMessage}`,
    ];
    return lines.join('\n');
}

async function showPathDiagnostics(): Promise<void> {
    const diagnostics = getStataPathDiagnostics();
    const backend = await getBackendDiagnostics(diagnostics.selectedPath);
    const report = await formatPathDiagnostics(diagnostics, backend);
    outputChannel.clear();
    outputChannel.appendLine(report);
    outputChannel.show(true);

    const detected = diagnostics.selectedPath || backend.pystataExists;
    const message = detected
        ? 'Stata path diagnostics written to the "Stata Console" output channel.'
        : 'No Stata executable was detected. See the "Stata Console" output channel for details.';
    const choice = detected
        ? await vscode.window.showInformationMessage(message, 'Copy Report')
        : await vscode.window.showWarningMessage(message, 'Copy Report');

    if (choice === 'Copy Report') {
        await vscode.env.clipboard.writeText(report);
        void vscode.window.showInformationMessage('Stata path diagnostics copied to clipboard.');
    }
}

function selectionTarget(editor: vscode.TextEditor): RunTarget {
    return {
        uri: editor.document.uri,
        line: editor.selection.start.line,
        from: editor.selection.start.line,
        to: editor.selection.end.line,
    };
}

function lineTarget(editor: vscode.TextEditor, line: number): RunTarget {
    return { uri: editor.document.uri, line, from: line, to: line };
}

function fileTarget(editor: vscode.TextEditor): RunTarget {
    return {
        uri: editor.document.uri,
        line: editor.selection.active.line,
        from: 0,
        to: Math.max(editor.document.lineCount - 1, 0),
    };
}

/** Command text without a trailing `//` comment, for comparing echoed and document lines. */
function commandText(text: string): string {
    return text.replace(/(^|\s)\/\/.*$/, '').trim();
}

/**
 * Stata reports no line numbers, so find the echoed command in the document:
 * first inside the executed range, then anywhere in the file.
 */
function findTargetLine(doc: vscode.TextDocument, errorLines: string[], target: RunTarget): number {
    const last = Math.max(doc.lineCount - 1, 0);
    const ranges: [number, number][] = [
        [Math.max(target.from, 0), Math.min(target.to, last)],
        [0, last],
    ];
    for (const eLine of errorLines) {
        const cmdMatch = eLine.match(/^\.\s+(.+)/);
        if (!cmdMatch) {
            continue;
        }
        const cmd = commandText(cmdMatch[1]);
        if (!cmd) {
            continue;
        }
        for (const [from, to] of ranges) {
            for (let i = from; i <= to; i++) {
                if (commandText(doc.lineAt(i).text) === cmd) {
                    return i;
                }
            }
        }
    }
    return Math.min(Math.max(target.line, 0), last);
}

async function applyStataDiagnostic(event: StataErrorEvent): Promise<void> {
    // Errors from commands typed in the console have no source line.
    if (!event.target) {
        return;
    }
    const errorLines = event.message.split('\n');
    const displayMsg = errorLines
        .filter((line) => !/^r\(\d+\);/.test(line.trim()) && !/^(\. |> )/.test(line))
        .join(' ')
        .trim() || event.message;

    try {
        const doc = await vscode.workspace.openTextDocument(event.target.uri);
        if (doc.lineCount === 0) {
            return;
        }
        const targetLine = findTargetLine(doc, errorLines, event.target);
        const diag = new vscode.Diagnostic(
            doc.lineAt(targetLine).range,
            displayMsg,
            vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'Stata';
        diagnosticCollection.set(doc.uri, [diag]);
    } catch {
        // The document is gone; nothing to annotate.
    }
}

let consoleStarting: Promise<StataTerminal | undefined> | undefined;

/** Open the console if needed. Concurrent callers share one startup and one terminal. */
function ensureConsole(): Promise<StataTerminal | undefined> {
    if (terminal && stataTerminal) {
        terminal.show(true);
        return Promise.resolve(stataTerminal);
    }
    if (!consoleStarting) {
        consoleStarting = createConsole().finally(() => { consoleStarting = undefined; });
    }
    return consoleStarting;
}

async function createConsole(): Promise<StataTerminal | undefined> {
    const { backend, error } = await resolveBackend();
    if (!backend) {
        vscode.window.showErrorMessage(
            error ?? 'Could not start Stata.',
            'Run Diagnostics',
            'Open Settings'
        ).then((choice) => {
            if (choice === 'Run Diagnostics') {
                void vscode.commands.executeCommand('stata.diagnosePath');
            } else if (choice === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'stata.stataPath');
            }
        });
        return undefined;
    }

    const session = new StataTerminal(backend);
    stataTerminal = session;

    // Graph panel + plots list
    session.onDidDetectGraph((graphPath) => {
        if (!graphPanel) {
            graphPanel = new GraphPanel(session.tempDir);
        }
        // The plots list follows the shared plot history store.
        graphPanel.show(graphPath);
    });

    // Data viewer (browse)
    session.onDidRequestBrowse(({ csvPath, totalObs }) => {
        if (!dataPanel) {
            dataPanel = new DataPanel(session.tempDir);
        }
        dataPanel.show(csvPath, totalObs);
    });

    // Data + Variables panels auto-update
    session.onDidUpdateVariables((meta) => {
        datasetPanel.update(meta);
        const varsPath = path.join(session.tempDir, '_vars.tsv');
        variablesPanel.refreshFromFile(varsPath);
        datasetVariables = readVariableNames(varsPath);
        if (meta.obs > 0) {
            const name = meta.filename
                ? meta.filename.replace(/^.*[/\\]/, '').replace(/\.dta$/i, '')
                : 'data';
            statusBarItem.text = `$(database) ${name} (${meta.obs.toLocaleString()} × ${meta.vars})`;
            statusBarItem.tooltip = `${meta.filename || 'Current dataset'}\n${meta.obs.toLocaleString()} observations, ${meta.vars} variables${meta.label ? '\n' + meta.label : ''}`;
        } else {
            statusBarItem.text = '$(terminal) Stata';
        }
    });

    // Stored results auto-update
    session.onDidUpdateResults(() => {
        storedResultsPanel.refreshFromFile(
            path.join(session.tempDir, '_results.tsv')
        );
    });

    // Running indicator — spinner in status bar while Stata is busy
    session.onDidChangeBusy((busy) => {
        if (busy) {
            busyStatusItem.text = '$(sync~spin) Running...';
            busyStatusItem.show();
        } else {
            busyStatusItem.hide();
        }
    });

    session.onDidStartExecution((origin) => {
        if (origin === 'interactive') {
            diagnosticCollection.clear();
        }
    });

    // Diagnostics from Stata errors
    session.onDidDetectError((event) => {
        void applyStataDiagnostic(event);
    });

    const term = vscode.window.createTerminal({
        name: 'Stata Console',
        pty: session,
    });
    terminal = term;

    statusBarItem.text = '$(terminal) Stata';
    statusBarItem.tooltip = `Stata Console — ${backend.label}`;
    vscode.commands.executeCommand('setContext', 'stata.consoleActive', true);
    updateStataTerminalFocus();

    const disposable = vscode.window.onDidCloseTerminal((t) => {
        if (t === term) {
            teardownConsole(term);
            disposable.dispose();
        }
    });

    term.show();
    return session;
}

/** Release everything tied to a console. Safe to call more than once. */
function teardownConsole(term: vscode.Terminal): void {
    if (terminal !== term) {
        return;
    }
    stataTerminal?.dispose();
    stataTerminal = undefined;
    terminal = undefined;
    graphPanel?.dispose();
    graphPanel = undefined;
    dataPanel?.dispose();
    dataPanel = undefined;
    datasetPanel.update();
    variablesPanel.refreshFromFile('');
    datasetVariables = [];
    storedResultsPanel.refreshFromFile('');
    plotsListPanel.clear();
    diagnosticCollection.clear();
    busyStatusItem.hide();
    statusBarItem.text = '$(terminal) Stata (inactive)';
    statusBarItem.tooltip = 'Click to open Stata Console';
    vscode.commands.executeCommand('setContext', 'stata.consoleActive', false);
    updateStataTerminalFocus();
}

function workingDirFor(doc: vscode.TextDocument): string | undefined {
    return doc.uri.scheme === 'file' ? path.dirname(doc.fileName) : undefined;
}

/** Send code to the console. The caller captures `target` before any await. */
function runCode(editor: vscode.TextEditor, code: string, target: RunTarget): void {
    if (code.trim() === '') { return; }
    const workingDir = workingDirFor(editor.document);
    void ensureConsole().then((session) => session?.sendCode(code, workingDir, target));
}

function runWholeFile(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const target = fileTarget(editor);
    const workingDir = workingDirFor(doc);
    if (doc.uri.scheme !== 'file') {
        // Untitled or virtual documents have no path Stata could open.
        runCode(editor, doc.getText(), target);
        return;
    }
    void doc.save().then(() => ensureConsole()).then((session) => {
        session?.sendCode(`do ${stataQuote(doc.fileName)}`, workingDir, target);
    });
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Stata Console');
    context.subscriptions.push(outputChannel);

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(terminal) Stata (inactive)';
    statusBarItem.command = 'stata.openConsole';
    statusBarItem.tooltip = 'Click to open Stata Console';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Busy/running indicator in status bar
    busyStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    busyStatusItem.text = '$(sync~spin) Running...';
    busyStatusItem.tooltip = 'Stata is executing code';
    context.subscriptions.push(busyStatusItem);

    // Diagnostics collection for Stata errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('stata');
    context.subscriptions.push(diagnosticCollection);

    // Scope console keybindings (e.g. Clear Console) to the Stata terminal only
    context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(updateStataTerminalFocus));

    // Sidebar panels
    datasetPanel = new DatasetPanel();
    variablesPanel = new VariablesPanel();
    storedResultsPanel = new StoredResultsPanel();
    plotsListPanel = new PlotsListPanel();

    context.subscriptions.push(
        vscode.window.createTreeView('stataDataset', {
            treeDataProvider: datasetPanel,
        }),
        vscode.window.createTreeView('stataVariables', {
            treeDataProvider: variablesPanel,
            showCollapseAll: false,
        }),
        vscode.window.createTreeView('stataStoredResults', {
            treeDataProvider: storedResultsPanel,
            showCollapseAll: true,
        }),
        vscode.window.createTreeView('stataPlotsList', {
            treeDataProvider: plotsListPanel,
        }),
    );

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.openConsole', () => {
            void ensureConsole();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.diagnosePath', async () => {
            await showPathDiagnostics();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            diagnosticCollection.clear();
            if (!editor.selection.isEmpty) {
                runCode(editor, editor.document.getText(editor.selection), selectionTarget(editor));
            } else {
                runWholeFile(editor);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.runSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            diagnosticCollection.clear();

            if (editor.selection.isEmpty) {
                // No selection — run current line and advance cursor
                const lineNum = editor.selection.active.line;
                const code = editor.document.lineAt(lineNum).text;

                // Always advance to next line (even for empty/comment lines)
                const next = Math.min(lineNum + 1, editor.document.lineCount - 1);
                const pos = new vscode.Position(next, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos));

                // Only send non-empty, non-comment lines to Stata
                const trimmed = code.trim();
                if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('//')) { return; }
                runCode(editor, code, lineTarget(editor, lineNum));
            } else {
                // Has selection — run it
                runCode(editor, editor.document.getText(editor.selection), selectionTarget(editor));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.runFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No file is open.'); return; }
            diagnosticCollection.clear();
            runWholeFile(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.browse', async () => {
            const session = await ensureConsole();
            session?.handleBrowse('');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.plotPrev', () => { graphPanel?.prev(); }),
        vscode.commands.registerCommand('stata.plotNext', () => { graphPanel?.next(); }),
        vscode.commands.registerCommand('stata.plotSave', () => { graphPanel?.save(); }),
        vscode.commands.registerCommand('stata.plotClear', () => {
            graphPanel?.clearAll();
            plotsListPanel.clear();
        }),
        vscode.commands.registerCommand('stata.deletePlot', (entry?: { index: number }) => {
            if (entry && entry.index >= 0) {
                plotsListPanel.deletePlot(entry.index);
            }
        }),
        vscode.commands.registerCommand('stata.showPlot', (index: number) => {
            // Called from plots list panel — navigate to specific plot
            if (graphPanel && index >= 0) {
                graphPanel.showByIndex(index);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.insertVariable', (varName: string) => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.edit(edit => { edit.insert(editor.selection.active, varName); });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.refreshVariables', () => {
            if (stataTerminal) {
                variablesPanel.refreshFromFile(path.join(stataTerminal.tempDir, '_vars.tsv'));
            }
        })
    );

    // Clear Console (clears the terminal display, not Stata's memory)
    context.subscriptions.push(
        vscode.commands.registerCommand('stata.clearConsole', () => {
            if (stataTerminal) {
                stataTerminal.clearScreen();
            }
        })
    );

    // Restart Stata
    context.subscriptions.push(
        vscode.commands.registerCommand('stata.restartStata', async () => {
            if (consoleStarting) {
                await consoleStarting;
            }
            const old = terminal;
            if (old) {
                teardownConsole(old);
                old.dispose();
            }
            await ensureConsole();
        })
    );

    // Auto-completion and hover help for Stata commands
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'stata' },
            new StataCompletionProvider(() => datasetVariables),
            '$', '`', '{',
        ),
        vscode.languages.registerHoverProvider(
            { language: 'stata' },
            new StataHoverProvider()
        ),
        vscode.languages.registerDocumentLinkProvider(
            { language: 'stata' },
            new StataLinkProvider()
        ),
        vscode.languages.registerDocumentSymbolProvider(
            { language: 'stata' },
            new StataOutlineProvider()
        ),
        vscode.languages.registerDefinitionProvider(
            { language: 'stata' },
            new StataDefinitionProvider()
        ),
    );

    // SMCL help file viewer
    registerSthlpViewer(context);
}

export function deactivate() {
    graphPanel?.dispose();
    dataPanel?.dispose();
    datasetPanel?.dispose();
    variablesPanel?.dispose();
    storedResultsPanel?.dispose();
    plotsListPanel?.dispose();
    busyStatusItem?.hide();
    stataTerminal?.dispose();
    terminal?.dispose();
}
