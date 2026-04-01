import * as vscode from 'vscode';
import * as path from 'path';
import { StataTerminal } from './stataTerminal';
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
import { getStataPath, getStataPathDiagnostics, getStataPathHelp } from './config';
import { registerSthlpViewer } from './sthlpViewer';

let stataTerminal: StataTerminal | undefined;
let terminal: vscode.Terminal | undefined;
let graphPanel: GraphPanel | undefined;
let dataPanel: DataPanel | undefined;
let statusBarItem: vscode.StatusBarItem;
let busyStatusItem: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;
let lastRunTarget: { uri: vscode.Uri; line: number } | undefined;

// Sidebar panels (created once in activate, persist across terminal sessions)
let datasetPanel: DatasetPanel;
let variablesPanel: VariablesPanel;
let storedResultsPanel: StoredResultsPanel;
let plotsListPanel: PlotsListPanel;

function formatPathDiagnostics(): string {
    const diagnostics = getStataPathDiagnostics();
    const lines = [
        'Stata Path Diagnostics',
        `Platform: ${diagnostics.platform}`,
        `Preferred edition: ${diagnostics.edition}`,
        `Configured stata.stataPath: ${diagnostics.configuredPath || '(empty)'}`,
        `Resolved configured path: ${diagnostics.resolvedConfiguredPath || '(not resolved)'}`,
        `Selected path: ${diagnostics.selectedPath || '(none)'}`,
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
    const report = formatPathDiagnostics();
    outputChannel.clear();
    outputChannel.appendLine(report);
    outputChannel.show(true);

    const message = diagnostics.selectedPath
        ? 'Stata path diagnostics written to the "Stata Console" output channel.'
        : 'No Stata executable was detected. See the "Stata Console" output channel for details.';
    const choice = diagnostics.selectedPath
        ? await vscode.window.showInformationMessage(message, 'Copy Report')
        : await vscode.window.showWarningMessage(message, 'Copy Report');

    if (choice === 'Copy Report') {
        await vscode.env.clipboard.writeText(report);
        void vscode.window.showInformationMessage('Stata path diagnostics copied to clipboard.');
    }
}

function recordRunTarget(editor: vscode.TextEditor, line: number): void {
    lastRunTarget = {
        uri: editor.document.uri,
        line,
    };
}

function findTargetLine(doc: vscode.TextDocument, errorLines: string[], fallbackLine: number): number {
    for (const eLine of errorLines) {
        const cmdMatch = eLine.match(/^\.\s+(.+)/);
        if (!cmdMatch) {
            continue;
        }
        const cmd = cmdMatch[1].trim();
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.trim() === cmd) {
                return i;
            }
        }
    }
    return Math.min(Math.max(fallbackLine, 0), Math.max(doc.lineCount - 1, 0));
}

async function applyStataDiagnostic(errorMsg: string): Promise<void> {
    const errorLines = errorMsg.split('\n');
    const displayMsg = errorLines.filter((line) => !/^r\(\d+\);/.test(line.trim())).join(' ').trim() || errorMsg;

    if (lastRunTarget) {
        try {
            const doc = await vscode.workspace.openTextDocument(lastRunTarget.uri);
            const targetLine = findTargetLine(doc, errorLines, lastRunTarget.line);
            const diag = new vscode.Diagnostic(
                doc.lineAt(targetLine).range,
                displayMsg,
                vscode.DiagnosticSeverity.Error,
            );
            diag.source = 'Stata';
            diagnosticCollection.set(doc.uri, [diag]);
            return;
        } catch {
            // Fall back to the active editor below.
        }
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const targetLine = findTargetLine(editor.document, errorLines, editor.selection.active.line);
    const diag = new vscode.Diagnostic(
        editor.document.lineAt(targetLine).range,
        displayMsg,
        vscode.DiagnosticSeverity.Error,
    );
    diag.source = 'Stata';
    diagnosticCollection.set(editor.document.uri, [diag]);
}

function ensureConsole(): boolean {
    if (terminal && stataTerminal) {
        terminal.show(true);
        return true;
    }

    const stataPath = getStataPath();
    if (!stataPath) {
        vscode.window.showErrorMessage(
            getStataPathHelp(),
            'Run Diagnostics',
            'Open Settings'
        ).then((choice) => {
            if (choice === 'Run Diagnostics') {
                void vscode.commands.executeCommand('stata.diagnosePath');
            } else if (choice === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'stata.stataPath');
            }
        });
        return false;
    }

    stataTerminal = new StataTerminal(stataPath);

    // Graph panel + plots list
    stataTerminal.onDidDetectGraph((graphPath) => {
        if (!graphPanel) {
            graphPanel = new GraphPanel(stataTerminal!.tempDir);
        }
        graphPanel.show(graphPath);
        plotsListPanel.addPlot(graphPath);
    });

    // Data viewer (browse)
    stataTerminal.onDidRequestBrowse(({ csvPath, totalObs }) => {
        if (!dataPanel) {
            dataPanel = new DataPanel(stataTerminal!.tempDir);
        }
        dataPanel.show(csvPath, totalObs);
    });

    // Data + Variables panels auto-update
    stataTerminal.onDidUpdateVariables((meta) => {
        datasetPanel.update(meta);
        variablesPanel.refreshFromFile(
            path.join(stataTerminal!.tempDir, '_vars.tsv')
        );
        if (meta.obs > 0) {
            const name = meta.filename
                ? meta.filename.replace(/^.*[/\\]/, '').replace(/\.dta$/i, '')
                : 'data';
            statusBarItem.text = `$(database) ${name} (${meta.obs.toLocaleString()} \u00D7 ${meta.vars})`;
            statusBarItem.tooltip = `${meta.filename || 'Current dataset'}\n${meta.obs.toLocaleString()} observations, ${meta.vars} variables${meta.label ? '\n' + meta.label : ''}`;
        } else {
            statusBarItem.text = '$(terminal) Stata';
        }
    });

    // Stored results auto-update
    stataTerminal.onDidUpdateResults(() => {
        storedResultsPanel.refreshFromFile(
            path.join(stataTerminal!.tempDir, '_results.tsv')
        );
    });

    // Running indicator — spinner in status bar while Stata is busy
    stataTerminal.onDidChangeBusy((busy) => {
        if (busy) {
            busyStatusItem.text = '$(sync~spin) Running...';
            busyStatusItem.show();
        } else {
            busyStatusItem.hide();
        }
    });

    stataTerminal.onDidStartExecution((origin) => {
        if (origin === 'interactive') {
            lastRunTarget = undefined;
            diagnosticCollection.clear();
        }
    });

    // Diagnostics from Stata errors
    stataTerminal.onDidDetectError((errorMsg) => {
        void applyStataDiagnostic(errorMsg);
    });

    terminal = vscode.window.createTerminal({
        name: 'Stata Console',
        pty: stataTerminal,
    });

    statusBarItem.text = '$(terminal) Stata';
    statusBarItem.tooltip = `Stata Console \u2014 ${stataPath}`;
    vscode.commands.executeCommand('setContext', 'stata.consoleActive', true);

    const disposable = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
            stataTerminal?.dispose();
            stataTerminal = undefined;
            terminal = undefined;
            graphPanel?.dispose();
            graphPanel = undefined;
            dataPanel?.dispose();
            dataPanel = undefined;
            datasetPanel.update();
            variablesPanel.refreshFromFile('');
            storedResultsPanel.refreshFromFile('');
            plotsListPanel.clear();
            lastRunTarget = undefined;
            statusBarItem.text = '$(terminal) Stata (inactive)';
            statusBarItem.tooltip = 'Click to open Stata Console';
            vscode.commands.executeCommand('setContext', 'stata.consoleActive', false);
            disposable.dispose();
        }
    });

    terminal.show();
    return true;
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
            ensureConsole();
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
            const fileDir = path.dirname(editor.document.fileName);
            if (!editor.selection.isEmpty) {
                const code = editor.document.getText(editor.selection);
                if (code.trim() === '') { return; }
                if (!ensureConsole()) { return; }
                recordRunTarget(editor, editor.selection.start.line);
                stataTerminal!.sendCode(code, fileDir);
            } else {
                const filePath = editor.document.fileName;
                if (!filePath) { return; }
                editor.document.save().then(() => {
                    if (!ensureConsole()) { return; }
                    recordRunTarget(editor, editor.selection.active.line);
                    stataTerminal!.sendCode(`do "${filePath}"`, fileDir);
                });
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
                if (!ensureConsole()) { return; }
                recordRunTarget(editor, lineNum);
                stataTerminal!.sendCode(code, path.dirname(editor.document.fileName));
            } else {
                // Has selection — run it
                const code = editor.document.getText(editor.selection);
                if (code.trim() === '') { return; }
                if (!ensureConsole()) { return; }
                recordRunTarget(editor, editor.selection.start.line);
                stataTerminal!.sendCode(code, path.dirname(editor.document.fileName));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.runFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No file is open.'); return; }
            diagnosticCollection.clear();
            const filePath = editor.document.fileName;
            if (!filePath) { return; }
            editor.document.save().then(() => {
                if (!ensureConsole()) { return; }
                recordRunTarget(editor, editor.selection.active.line);
                stataTerminal!.sendCode(`do "${filePath}"`, path.dirname(filePath));
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.browse', () => {
            if (!ensureConsole()) { return; }
            stataTerminal!.handleBrowse('');
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
        vscode.commands.registerCommand('stata.restartStata', () => {
            if (terminal) {
                terminal.dispose(); // triggers cleanup via onDidCloseTerminal
            }
            setTimeout(() => ensureConsole(), 500);
        })
    );

    // Auto-completion and hover help for Stata commands
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'stata' },
            new StataCompletionProvider()
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
    stataTerminal?.dispose();
    terminal?.dispose();
}
