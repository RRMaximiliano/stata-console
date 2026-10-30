import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { createNonce, crossPlatformBasename, escapeHtml, serializeJsonForHtml } from './htmlUtils';
import { PlotHistoryStore, sharedPlotHistoryStore } from './plotHistoryStore';

type GraphWebviewPayload =
    | { type: 'empty' }
    | {
        type: 'plot';
        src: string;
        index: number;
        total: number;
        hasPrev: boolean;
        hasNext: boolean;
        plotId: number;
    };

const ALLOWED_ACTIONS = new Set(['ready', 'prev', 'next', 'save', 'delete', 'clear']);

function isValidGraphMessage(msg: unknown): msg is { type: string } {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        typeof (msg as { type?: unknown }).type === 'string' &&
        ALLOWED_ACTIONS.has((msg as { type: string }).type)
    );
}

export class GraphPanel {
    private panel: vscode.WebviewPanel | undefined;
    private readonly tempDir: string;
    private readonly store: PlotHistoryStore;
    private readonly unsubscribeStore: () => void;
    private webviewReady = false;
    private syncing = false;

    constructor(tempDir: string, store: PlotHistoryStore = sharedPlotHistoryStore) {
        this.tempDir = tempDir;
        this.store = store;
        this.store.setTempDir(tempDir);
        this.unsubscribeStore = this.store.onChange(() => {
            if (!this.syncing && this.panel) {
                this.syncWebview(false);
            }
        });
    }

    show(imagePath: string): void {
        this.syncing = true;
        let status: 'added' | 'duplicate' | 'invalid';
        try {
            const result = this.store.ingestFromGraphPanel(imagePath, this.tempDir);
            status = result.status;
        } finally {
            this.syncing = false;
        }

        if (status === 'invalid') {
            return;
        }
        if (status === 'duplicate') {
            // Identical consecutive plot (e.g. re-exported by _post.do after non-graph command)
            if (this.panel) {
                this.syncWebview(false);
            }
            return;
        }

        this.syncWebview(true);
    }

    prev(): void {
        this.syncing = true;
        try {
            if (!this.store.prev()) {
                return;
            }
        } finally {
            this.syncing = false;
        }
        this.syncWebview(false);
    }

    next(): void {
        this.syncing = true;
        try {
            if (!this.store.next()) {
                return;
            }
        } finally {
            this.syncing = false;
        }
        this.syncWebview(false);
    }

    showByIndex(index: number): void {
        this.syncing = true;
        let found = false;
        try {
            found = Boolean(this.store.setCurrentIndex(index));
        } finally {
            this.syncing = false;
        }
        if (found) {
            this.syncWebview(true);
        }
    }

    deleteAt(index: number): void {
        this.syncing = true;
        try {
            this.store.deleteAt(index);
        } finally {
            this.syncing = false;
        }
        if (this.panel) {
            this.syncWebview(false);
        }
    }

    deleteCurrent(): void {
        const idx = this.store.getCurrentIndex();
        if (idx >= 0) {
            this.deleteAt(idx);
        }
    }

    async save(): Promise<void> {
        const current = this.store.getCurrentPlot();
        const currentIndex = this.store.getCurrentIndex();
        if (!current || currentIndex < 0 || !fs.existsSync(current.historyPath)) {
            return;
        }

        const baseFolderUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
        const defaultUri = vscode.Uri.joinPath(baseFolderUri, `stata_plot_${currentIndex + 1}.png`);
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                'PNG Image': ['png'],
            },
        });
        if (!uri) {
            return;
        }

        try {
            const bytes = fs.readFileSync(current.historyPath);
            await vscode.workspace.fs.writeFile(uri, bytes);
            void vscode.window.showInformationMessage(`Saved: ${crossPlatformBasename(uri.fsPath || uri.path)}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Could not save plot: ${msg}`);
        }
    }

    clearAll(): void {
        this.syncing = true;
        try {
            this.store.clear();
        } finally {
            this.syncing = false;
        }
        if (this.panel) {
            this.syncWebview(false);
        }
    }

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }

        this.webviewReady = false;
        const panel = vscode.window.createWebviewPanel(
            'stataGraph',
            'Stata Plots',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                enableCommandUris: false,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(this.tempDir)],
            },
        );

        panel.webview.onDidReceiveMessage((msg: unknown) => {
            if (!isValidGraphMessage(msg)) {
                return;
            }
            switch (msg.type) {
                case 'ready':
                    this.webviewReady = true;
                    if (this.panel) {
                        void this.panel.webview.postMessage(this.buildPayload(this.panel.webview));
                    }
                    break;
                case 'prev':
                    this.prev();
                    break;
                case 'next':
                    this.next();
                    break;
                case 'save':
                    void this.save();
                    break;
                case 'delete':
                    this.deleteCurrent();
                    break;
                case 'clear':
                    this.clearAll();
                    break;
            }
        });

        panel.onDidDispose(() => {
            this.panel = undefined;
            this.webviewReady = false;
        });

        this.panel = panel;
        const initialPayload = this.buildPayload(panel.webview);
        panel.webview.html = this.getShellHtml(panel.webview, initialPayload);
        return panel;
    }

    private buildPayload(webview: vscode.Webview): GraphWebviewPayload {
        const plots = this.store.getPlots();
        const currentIndex = this.store.getCurrentIndex();
        const current = this.store.getCurrentPlot();
        if (!current || currentIndex < 0 || plots.length === 0 || !fs.existsSync(current.historyPath)) {
            return { type: 'empty' };
        }

        // Always build Windows-safe URI through webview.asWebviewUri(vscode.Uri.file(...))
        const webviewUri = webview.asWebviewUri(vscode.Uri.file(current.historyPath));
        const rawUri = webviewUri.toString();
        const sep = rawUri.includes('?') ? '&' : '?';
        const cacheBustedSrc = `${rawUri}${sep}v=${encodeURIComponent(current.hash.slice(0, 12))}_${Date.now()}`;

        return {
            type: 'plot',
            src: cacheBustedSrc,
            index: currentIndex,
            total: plots.length,
            hasPrev: currentIndex > 0,
            hasNext: currentIndex < plots.length - 1,
            plotId: current.id,
        };
    }

    private syncWebview(reveal: boolean): void {
        const panel = reveal ? this.ensurePanel() : this.panel;
        if (!panel) {
            return;
        }

        const payload = this.buildPayload(panel.webview);
        panel.title = payload.type === 'plot'
            ? `Plots (${payload.index + 1} / ${payload.total})`
            : 'Plots';

        if (this.webviewReady) {
            void panel.webview.postMessage(payload);
        }

        if (reveal) {
            panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
        }
    }

    private getShellHtml(webview: vscode.Webview, initialPayload: GraphWebviewPayload): string {
        const nonce = createNonce();
        const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';`;
        const serializedInitial = serializeJsonForHtml(initialPayload);

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --header-bg: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
    --border: var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128, 128, 128, 0.28)));
    --btn-bg: var(--vscode-button-secondaryBackground);
    --btn-fg: var(--vscode-button-secondaryForeground);
    --btn-hover: var(--vscode-button-secondaryHoverBackground, var(--btn-bg));
    --focus: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
    --stage-bg: var(--vscode-editorWidget-background, var(--bg));
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px;
}
.empty-state {
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    color: var(--muted);
    text-align: center;
}
.empty-state.active { display: flex; }
.empty-state .title { font-size: 14px; font-weight: 600; color: var(--fg); }
.empty-state .sub { margin-top: 6px; font-size: 12px; }
.viewer {
    display: none;
    flex-direction: column;
    height: 100vh;
}
.viewer.active { display: flex; }
.toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
}
button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 9px;
    min-width: 28px;
    height: 24px;
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
}
button:hover:not(:disabled) { background: var(--btn-hover); }
button:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
button:disabled { opacity: 0.35; cursor: default; }
button.active-mode { border-color: var(--focus); font-weight: 600; }
.divider {
    width: 1px;
    height: 16px;
    background: var(--border);
    margin: 0 2px;
}
.label-info {
    color: var(--muted);
    font-size: 11px;
    min-width: 44px;
    text-align: center;
    font-variant-numeric: tabular-nums;
}
.spacer { flex: 1; }
.plot-viewport {
    flex: 1;
    overflow: auto;
    display: flex;
    padding: 16px;
    background: var(--bg);
}
.plot-viewport.fit-mode {
    justify-content: center;
    align-items: center;
    overflow: hidden;
}
.plot-viewport-inner {
    margin: auto;
    display: flex;
    justify-content: center;
    align-items: center;
}
.plot-viewport.fit-mode .plot-viewport-inner {
    width: 100%;
    height: 100%;
}
.plot-frame {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    background: var(--stage-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
}
.plot-frame.light-paper {
    background: #ffffff;
}
.plot-viewport.fit-mode .plot-frame {
    max-width: 100%;
    max-height: 100%;
}
img#plotImg {
    display: block;
    user-select: none;
    -webkit-user-drag: none;
}
.plot-viewport.fit-mode img#plotImg {
    max-width: 100%;
    max-height: calc(100vh - 76px);
    width: auto;
    height: auto;
    object-fit: contain;
}
.plot-viewport.panning { cursor: grabbing; }
.plot-viewport.zoomed { cursor: grab; }
</style>
</head>
<body>
<div class="empty-state" id="emptyState">
    <div class="title">No plots</div>
    <div class="sub">Run a Stata graph command to view plots here</div>
</div>
<div class="viewer" id="viewerRoot">
    <div class="toolbar">
        <button type="button" id="prevBtn" title="Previous Plot (\u2190)">\u25C0</button>
        <button type="button" id="nextBtn" title="Next Plot (\u2192)">\u25B6</button>
        <span class="label-info" id="counterLabel">0 / 0</span>
        <div class="divider"></div>
        <button type="button" id="fitBtn" class="active-mode" title="Fit plot to panel">Fit</button>
        <button type="button" id="zoomOutBtn" title="Zoom out">\u2212</button>
        <span class="label-info" id="zoomLabel">Fit</span>
        <button type="button" id="zoomInBtn" title="Zoom in">+</button>
        <button type="button" id="actualBtn" title="Actual size (100%)">100%</button>
        <div class="divider"></div>
        <button type="button" id="bgBtn" title="Toggle plot canvas background (Theme / White)">Canvas</button>
        <div class="spacer"></div>
        <button type="button" id="deleteBtn" title="Delete current plot from history">Delete</button>
        <button type="button" id="saveBtn" title="Save Plot As PNG\u2026">Save As\u2026</button>
    </div>
    <div class="plot-viewport fit-mode" id="viewport">
        <div class="plot-viewport-inner">
            <div class="plot-frame" id="plotFrame">
                <img id="plotImg" alt="Stata plot" />
            </div>
        </div>
    </div>
</div>
<script nonce="${escapeHtml(nonce)}">
(function() {
    const vscode = acquireVsCodeApi();
    const emptyState = document.getElementById('emptyState');
    const viewerRoot = document.getElementById('viewerRoot');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const counterLabel = document.getElementById('counterLabel');
    const fitBtn = document.getElementById('fitBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const actualBtn = document.getElementById('actualBtn');
    const zoomLabel = document.getElementById('zoomLabel');
    const bgBtn = document.getElementById('bgBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const saveBtn = document.getElementById('saveBtn');
    const viewport = document.getElementById('viewport');
    const plotFrame = document.getElementById('plotFrame');
    const plotImg = document.getElementById('plotImg');

    let fitMode = true;
    let zoom = 1;
    let lightPaper = false;
    let naturalW = 800;

    plotImg.addEventListener('load', function() {
        if (plotImg.naturalWidth > 0) {
            naturalW = plotImg.naturalWidth;
            updateZoomStyles();
        }
    });

    function setZoom(newZoom, isFit) {
        fitMode = Boolean(isFit);
        if (!fitMode) {
            zoom = Math.min(4, Math.max(0.25, Math.round(newZoom * 100) / 100));
        }
        updateZoomStyles();
    }

    function updateZoomStyles() {
        fitBtn.classList.toggle('active-mode', fitMode);
        actualBtn.classList.toggle('active-mode', !fitMode && Math.abs(zoom - 1) < 0.01);
        viewport.classList.toggle('fit-mode', fitMode);
        viewport.classList.toggle('zoomed', !fitMode);
        if (fitMode) {
            plotImg.style.width = '';
            plotImg.style.height = '';
            zoomLabel.textContent = 'Fit';
        } else {
            plotImg.style.width = Math.round(naturalW * zoom) + 'px';
            plotImg.style.height = 'auto';
            zoomLabel.textContent = Math.round(zoom * 100) + '%';
        }
    }

    prevBtn.addEventListener('click', function() { vscode.postMessage({ type: 'prev' }); });
    nextBtn.addEventListener('click', function() { vscode.postMessage({ type: 'next' }); });
    saveBtn.addEventListener('click', function() { vscode.postMessage({ type: 'save' }); });
    deleteBtn.addEventListener('click', function() { vscode.postMessage({ type: 'delete' }); });

    fitBtn.addEventListener('click', function() { setZoom(1, true); });
    actualBtn.addEventListener('click', function() { setZoom(1, false); });
    zoomInBtn.addEventListener('click', function() {
        const base = fitMode ? 1 : zoom;
        setZoom(base + 0.25, false);
    });
    zoomOutBtn.addEventListener('click', function() {
        const base = fitMode ? 1 : zoom;
        setZoom(base - 0.25, false);
    });
    bgBtn.addEventListener('click', function() {
        lightPaper = !lightPaper;
        plotFrame.classList.toggle('light-paper', lightPaper);
        bgBtn.classList.toggle('active-mode', lightPaper);
    });

    viewport.addEventListener('wheel', function(e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15;
            const base = fitMode ? 1 : zoom;
            setZoom(base + delta, false);
        }
    }, { passive: false });

    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    viewport.addEventListener('mousedown', function(e) {
        if (fitMode || e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = viewport.scrollLeft;
        startTop = viewport.scrollTop;
        viewport.classList.add('panning');
    });
    window.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        viewport.scrollLeft = startLeft - (e.clientX - startX);
        viewport.scrollTop = startTop - (e.clientY - startY);
    });
    window.addEventListener('mouseup', function() {
        if (dragging) {
            dragging = false;
            viewport.classList.remove('panning');
        }
    });

    window.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft') {
            vscode.postMessage({ type: 'prev' });
        } else if (e.key === 'ArrowRight') {
            vscode.postMessage({ type: 'next' });
        } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
            setZoom(1, true);
        }
    });

    function applyPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'empty') {
            viewerRoot.classList.remove('active');
            emptyState.classList.add('active');
            plotImg.removeAttribute('src');
            return;
        }
        if (payload.type !== 'plot' || typeof payload.src !== 'string') {
            return;
        }

        emptyState.classList.remove('active');
        viewerRoot.classList.add('active');

        const idx = Number(payload.index) || 0;
        const total = Number(payload.total) || 1;
        counterLabel.textContent = (idx + 1) + ' / ' + total;
        prevBtn.disabled = !payload.hasPrev;
        nextBtn.disabled = !payload.hasNext;
        plotImg.alt = 'Plot ' + (idx + 1);
        plotImg.src = payload.src;
        updateZoomStyles();
    }

    window.addEventListener('message', function(event) {
        applyPayload(event.data);
    });

    const initialData = ${serializedInitial};
    applyPayload(initialData);
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.unsubscribeStore();
        this.panel?.dispose();
    }
}
