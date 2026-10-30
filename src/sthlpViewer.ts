import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getStataPathDiagnostics } from './config';
import { createNonce } from './htmlUtils';
import {
    buildHelpFileCandidates,
    deriveStataInstallRoots,
    parseHelpTarget,
    resolveBrowseTarget,
    smclToHtml,
} from './smclParser';

export { smclToHtml };

let currentPanel: vscode.WebviewPanel | undefined;
let currentPreviewFilePath = '';

function isSthlpFileName(fileName: string): boolean {
    return /\.(?:sthlp|hlp)$/i.test(fileName);
}

function getPlatformStataSearchRoots(): string[] {
    const roots: string[] = [];
    const home = os.homedir();

    try {
        const diag = getStataPathDiagnostics();
        if (diag.selectedPath) {
            roots.push(...deriveStataInstallRoots(diag.selectedPath));
        }
    } catch {
        // Diagnostics lookup is best-effort
    }

    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            roots.push(folder.uri.fsPath);
        }
    }

    if (process.platform === 'win32') {
        roots.push(path.join(home, 'ado', 'plus'), path.join(home, 'ado', 'personal'));
        const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
            (v): v is string => Boolean(v),
        );
        for (const pf of programFiles) {
            try {
                for (const entry of fs.readdirSync(pf)) {
                    if (/^stata/i.test(entry)) {
                        roots.push(path.join(pf, entry));
                    }
                }
            } catch {
                // Ignore unreadable Program Files directories
            }
        }
    } else if (process.platform === 'darwin') {
        roots.push(
            '/Applications/StataNow',
            '/Applications/Stata',
            path.join(home, 'Library', 'Application Support', 'Stata', 'ado', 'plus'),
            path.join(home, 'Library', 'Application Support', 'Stata', 'ado', 'personal'),
            path.join(home, 'ado', 'plus'),
        );
    } else {
        roots.push(path.join(home, 'ado', 'plus'), path.join(home, 'ado', 'personal'));
        for (const base of ['/usr/local', '/opt']) {
            try {
                for (const entry of fs.readdirSync(base)) {
                    if (/^stata/i.test(entry)) {
                        roots.push(path.join(base, entry));
                    }
                }
            } catch {
                // Ignore
            }
        }
    }

    return Array.from(new Set(roots));
}

function findExistingFileCaseInsensitive(candidates: readonly string[]): string | undefined {
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Ignore inaccessible candidate
        }
    }

    // Fallback case-insensitive match within existing parent directories (helps on Linux with mixed-case topics)
    for (const candidate of candidates) {
        const dir = path.dirname(candidate);
        const targetLower = path.basename(candidate).toLowerCase();
        try {
            if (!fs.existsSync(dir)) {
                continue;
            }
            const match = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === targetLower);
            if (match) {
                const resolved = path.join(dir, match);
                if (fs.statSync(resolved).isFile()) {
                    return resolved;
                }
            }
        } catch {
            // Ignore
        }
    }

    return undefined;
}

function resolveIncludeContent(includeTopic: string, sourceFilePath: string, searchRoots: readonly string[]): string | undefined {
    const candidates = buildHelpFileCandidates(includeTopic, {
        currentFilePath: sourceFilePath,
        searchRoots,
        extensions: ['.ihlp', '.sthlp'],
    });
    const found = findExistingFileCaseInsensitive(candidates);
    if (!found) {
        return undefined;
    }
    try {
        return fs.readFileSync(found, 'utf-8');
    } catch {
        return undefined;
    }
}

function isValidSthlpMessage(msg: unknown): msg is { type: string; target?: unknown; url?: unknown; filePath?: unknown } {
    return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}

function handleWebviewMessage(rawMsg: unknown): void {
    if (!isValidSthlpMessage(rawMsg)) {
        return;
    }

    if (rawMsg.type === 'openHelp' && typeof rawMsg.target === 'string') {
        const parsed = parseHelpTarget(rawMsg.target);
        if (!parsed) {
            return;
        }

        const currentBase = path.basename(currentPreviewFilePath, path.extname(currentPreviewFilePath));
        if ((!parsed.topic || parsed.topic.toLowerCase() === currentBase.toLowerCase()) && parsed.anchor) {
            if (currentPanel) {
                void currentPanel.webview.postMessage({ type: 'scrollToAnchor', anchor: parsed.anchor });
            }
            return;
        }

        if (!parsed.topic) {
            return;
        }

        const searchRoots = getPlatformStataSearchRoots();
        const candidates = buildHelpFileCandidates(parsed.topic, {
            currentFilePath: currentPreviewFilePath,
            searchRoots,
            extensions: ['.sthlp', '.hlp'],
        });
        const found = findExistingFileCaseInsensitive(candidates);
        if (found) {
            openSthlpPreview(vscode.Uri.file(found), parsed.anchor || undefined);
        } else {
            void vscode.window.showInformationMessage(`Help file for "${parsed.topic}" was not found locally.`);
        }
        return;
    }

    if (rawMsg.type === 'openExternal' && typeof rawMsg.url === 'string') {
        const resolved = resolveBrowseTarget(rawMsg.url, currentPreviewFilePath);
        if (resolved.kind === 'external') {
            void vscode.env.openExternal(vscode.Uri.parse(resolved.url));
        }
        return;
    }

    if (rawMsg.type === 'openLocalFile' && typeof rawMsg.filePath === 'string') {
        const resolved = resolveBrowseTarget(rawMsg.filePath, currentPreviewFilePath);
        if (resolved.kind !== 'localFile') {
            return;
        }
        try {
            if (!fs.existsSync(resolved.filePath) || !fs.statSync(resolved.filePath).isFile()) {
                void vscode.window.showWarningMessage(`File not found: ${path.basename(resolved.filePath)}`);
                return;
            }
            const uri = vscode.Uri.file(resolved.filePath);
            if (isSthlpFileName(resolved.filePath)) {
                openSthlpPreview(uri);
            } else {
                void vscode.window.showTextDocument(uri, { preview: true });
            }
        } catch {
            void vscode.window.showWarningMessage(`Could not open file: ${path.basename(resolved.filePath)}`);
        }
    }
}

function renderFileIntoPanel(panel: vscode.WebviewPanel, filePath: string, initialAnchor?: string): boolean {
    let smclText: string;
    try {
        if (!fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`File not found: ${filePath}`);
            return false;
        }
        smclText = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Could not read help file: ${msg}`);
        return false;
    }

    currentPreviewFilePath = filePath;
    const fileName = path.basename(filePath);
    const searchRoots = getPlatformStataSearchRoots();
    const nonce = createNonce();

    panel.title = `Preview: ${fileName}`;
    panel.webview.html = smclToHtml(smclText, fileName, {
        nonce,
        cspSource: panel.webview.cspSource,
        currentFilePath: filePath,
        includeResolver: (topic) => resolveIncludeContent(topic, filePath, searchRoots),
        initialAnchor,
    });
    return true;
}

export function openSthlpPreview(fileUri?: vscode.Uri, anchor?: string): void {
    let targetUri = fileUri;
    if (!targetUri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No .sthlp file is open.');
            return;
        }
        targetUri = editor.document.uri;
    }

    const filePath = targetUri.fsPath;
    if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
        return;
    }

    const fileName = path.basename(filePath);

    if (currentPanel) {
        if (renderFileIntoPanel(currentPanel, filePath, anchor)) {
            currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Beside, true);
        }
    } else {
        const panel = vscode.window.createWebviewPanel(
            'stataSthlpPreview',
            `Preview: ${fileName}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                enableCommandUris: false,
                localResourceRoots: [],
            },
        );
        currentPanel = panel;
        panel.webview.onDidReceiveMessage((msg: unknown) => {
            handleWebviewMessage(msg);
        });
        panel.onDidDispose(() => {
            if (currentPanel === panel) {
                currentPanel = undefined;
                currentPreviewFilePath = '';
            }
        });
        if (!renderFileIntoPanel(panel, filePath, anchor)) {
            panel.dispose();
        }
    }
}

export function registerSthlpViewer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('stata.previewSthlp', (uri?: vscode.Uri) => {
            openSthlpPreview(uri);
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const isSthlp = Boolean(editor && isSthlpFileName(editor.document.fileName));
            void vscode.commands.executeCommand('setContext', 'stata.isSthlpFile', isSthlp);
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (
                currentPanel &&
                currentPreviewFilePath &&
                path.resolve(doc.uri.fsPath).toLowerCase() === path.resolve(currentPreviewFilePath).toLowerCase()
            ) {
                renderFileIntoPanel(currentPanel, currentPreviewFilePath);
            }
        }),
    );

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isSthlpFileName(activeEditor.document.fileName)) {
        void vscode.commands.executeCommand('setContext', 'stata.isSthlpFile', true);
    }
}
