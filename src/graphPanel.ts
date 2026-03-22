import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class GraphPanel {
    private panel: vscode.WebviewPanel | undefined;
    private tempDir: string;
    private plots: string[] = [];
    private currentIndex = -1;
    private plotCounter = 0;

    constructor(tempDir: string) {
        this.tempDir = tempDir;
    }

    show(imagePath: string): void {
        if (!fs.existsSync(imagePath)) { return; }
        const stat = fs.statSync(imagePath);
        if (stat.size < 100) { return; } // not a valid image

        // Copy to history file (async — don't block rendering)
        const historyFile = path.join(this.tempDir, `_plot_${++this.plotCounter}.png`);
        this.plots.push(historyFile);
        this.currentIndex = this.plots.length - 1;

        // Render immediately from the source, copy in background
        this.renderImage(imagePath);
        fs.copyFile(imagePath, historyFile, () => { /* done */ });
    }

    prev(): void {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            if (fs.existsSync(this.plots[i])) {
                this.currentIndex = i;
                this.render();
                return;
            }
        }
    }

    next(): void {
        for (let i = this.currentIndex + 1; i < this.plots.length; i++) {
            if (fs.existsSync(this.plots[i])) {
                this.currentIndex = i;
                this.render();
                return;
            }
        }
    }

    showByIndex(index: number): void {
        if (index >= 0 && index < this.plots.length && fs.existsSync(this.plots[index])) {
            this.currentIndex = index;
            this.render();
        }
    }

    async save(): Promise<void> {
        if (this.currentIndex < 0 || this.currentIndex >= this.plots.length) { return; }
        const plotPath = this.plots[this.currentIndex];
        if (!fs.existsSync(plotPath)) { return; }

        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(wsFolder, `stata_plot_${this.currentIndex + 1}.png`)),
            filters: {
                'PNG Image': ['png'],
                'All Files': ['*'],
            },
        });
        if (uri) {
            fs.copyFileSync(plotPath, uri.fsPath);
            vscode.window.showInformationMessage(`Saved: ${path.basename(uri.fsPath)}`);
        }
    }

    private render(): void {
        if (this.currentIndex < 0) { return; }
        const plotPath = this.plots[this.currentIndex];
        if (!fs.existsSync(plotPath)) { return; }
        this.renderImage(plotPath);
    }

    private renderImage(plotPath: string): void {

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'stataGraph',
                'Stata Plots',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                {
                    enableScripts: false,
                    enableCommandUris: true,
                    localResourceRoots: [vscode.Uri.file(this.tempDir)],
                }
            );
            this.panel.onDidDispose(() => { this.panel = undefined; });
        }

        const imageUri = this.panel.webview.asWebviewUri(vscode.Uri.file(plotPath));
        const cacheBust = Date.now();
        const hasPrev = this.currentIndex > 0;
        const hasNext = this.currentIndex < this.plots.length - 1;
        const counter = `${this.currentIndex + 1} / ${this.plots.length}`;

        this.panel.title = `Plots (${counter})`;
        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${imageUri.scheme}:; style-src 'unsafe-inline';">
<style>
:root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #ccc);
    --border: var(--vscode-panel-border, #333);
    --btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-fg: var(--vscode-button-secondaryForeground, #ccc);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, system-ui);
    font-size: 12px; display: flex; flex-direction: column; height: 100vh;
}
.toolbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.toolbar a {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 3px 10px; background: var(--btn-bg); color: var(--btn-fg);
    border: 1px solid var(--border); border-radius: 3px;
    text-decoration: none; font-size: 12px; cursor: pointer; min-width: 30px;
}
.toolbar a:hover { opacity: 0.9; }
.toolbar .disabled { opacity: 0.3; pointer-events: none; }
.toolbar .spacer { flex: 1; }
.toolbar .counter { color: #888; font-size: 11px; }
.plot-area {
    flex: 1; display: flex; justify-content: center; align-items: center;
    padding: 16px; overflow: auto; background: #fff;
}
img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
</head>
<body>
<div class="toolbar">
    <a href="command:stata.plotPrev" class="${hasPrev ? '' : 'disabled'}">\u25C0</a>
    <a href="command:stata.plotNext" class="${hasNext ? '' : 'disabled'}">\u25B6</a>
    <span class="counter">${counter}</span>
    <div class="spacer"></div>
    <a href="command:stata.plotSave">Save As\u2026</a>
</div>
<div class="plot-area">
    <img src="${imageUri}?t=${cacheBust}" alt="Plot ${this.currentIndex + 1}" />
</div>
</body>
</html>`;
        this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
