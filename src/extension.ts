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
import { getStataPath } from './config';

let stataTerminal: StataTerminal | undefined;
let terminal: vscode.Terminal | undefined;
let graphPanel: GraphPanel | undefined;
let dataPanel: DataPanel | undefined;
let statusBarItem: vscode.StatusBarItem;

// Sidebar panels (created once in activate, persist across terminal sessions)
let datasetPanel: DatasetPanel;
let variablesPanel: VariablesPanel;
let storedResultsPanel: StoredResultsPanel;
let plotsListPanel: PlotsListPanel;

function ensureConsole(): boolean {
    if (terminal && stataTerminal) {
        terminal.show(true);
        return true;
    }

    const stataPath = getStataPath();
    if (!stataPath) {
        vscode.window.showErrorMessage(
            'Stata not found. Set the path in Settings > Stata: Stata Path.',
            'Open Settings'
        ).then((choice) => {
            if (choice === 'Open Settings') {
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
    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(terminal) Stata (inactive)';
    statusBarItem.command = 'stata.openConsole';
    statusBarItem.tooltip = 'Click to open Stata Console';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

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
        vscode.commands.registerCommand('stata.run', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const fileDir = path.dirname(editor.document.fileName);
            if (!editor.selection.isEmpty) {
                const code = editor.document.getText(editor.selection);
                if (code.trim() === '') { return; }
                if (!ensureConsole()) { return; }
                stataTerminal!.sendCode(code, fileDir);
            } else {
                const filePath = editor.document.fileName;
                if (!filePath) { return; }
                editor.document.save().then(() => {
                    if (!ensureConsole()) { return; }
                    stataTerminal!.sendCode(`do "${filePath}"`, fileDir);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.runSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            let code: string;
            if (editor.selection.isEmpty) {
                const line = editor.document.lineAt(editor.selection.active.line);
                code = line.text;
                const next = Math.min(editor.selection.active.line + 1, editor.document.lineCount - 1);
                editor.selection = new vscode.Selection(new vscode.Position(next, 0), new vscode.Position(next, 0));
            } else {
                code = editor.document.getText(editor.selection);
            }
            if (code.trim() === '') { return; }
            if (!ensureConsole()) { return; }
            stataTerminal!.sendCode(code, path.dirname(editor.document.fileName));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('stata.runFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No file is open.'); return; }
            const filePath = editor.document.fileName;
            if (!filePath) { return; }
            editor.document.save().then(() => {
                if (!ensureConsole()) { return; }
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
    );
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
