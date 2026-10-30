import * as vscode from 'vscode';
import * as fs from 'fs';
import { createNonce, escapeHtml, serializeJsonForHtml } from './htmlUtils';
import { prepareCsvTable } from './dataUtils';

type DataViewerPayload =
    | { type: 'empty' }
    | {
        type: 'data';
        headers: string[];
        rows: string[][];
        numericCols: boolean[];
        showing: number;
        total: number;
        truncated: boolean;
        shapeKey: string;
    };

function isValidWebviewMessage(msg: unknown): msg is { type: string } {
    return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}

export class DataPanel {
    private panel: vscode.WebviewPanel | undefined;
    private readonly _tempDir: string;
    private latestPayload: DataViewerPayload = { type: 'empty' };
    private webviewReady = false;

    constructor(tempDir: string) {
        this._tempDir = tempDir;
    }

    show(csvPath: string, totalObs?: number): void {
        const payload = this.buildPayload(csvPath, totalObs);
        this.latestPayload = payload;

        const title = payload.type === 'data'
            ? (payload.truncated
                ? `Data Viewer (${payload.showing.toLocaleString()} of ${payload.total.toLocaleString()} obs)`
                : `Data Viewer (${payload.total.toLocaleString()} obs)`)
            : 'Data Viewer';

        if (!this.panel) {
            this.webviewReady = false;
            this.panel = vscode.window.createWebviewPanel(
                'stataData',
                title,
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                {
                    enableScripts: true,
                    enableCommandUris: false,
                    retainContextWhenHidden: true,
                    localResourceRoots: [],
                },
            );

            this.panel.webview.onDidReceiveMessage((msg: unknown) => {
                if (!isValidWebviewMessage(msg)) {
                    return;
                }
                if (msg.type === 'ready' && this.panel) {
                    this.webviewReady = true;
                    void this.panel.webview.postMessage(this.latestPayload);
                }
            });

            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.webviewReady = false;
            });

            this.panel.webview.html = this.getShellHtml(this.panel.webview, payload);
            return;
        }

        this.panel.title = title;
        if (this.webviewReady) {
            void this.panel.webview.postMessage(payload);
        }
        this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
    }

    private buildPayload(csvPath: string, totalObs?: number): DataViewerPayload {
        if (!csvPath) {
            return { type: 'empty' };
        }

        let content: string;
        try {
            if (!fs.existsSync(csvPath)) {
                return { type: 'empty' };
            }
            content = fs.readFileSync(csvPath, 'utf-8');
        } catch {
            return { type: 'empty' };
        }

        const rowLimit = vscode.workspace
            .getConfiguration('stata')
            .get<number>('browseRowLimit', 10000);
        const table = prepareCsvTable(content, rowLimit, totalObs);
        if (table.headers.length === 0) {
            return { type: 'empty' };
        }

        return {
            type: 'data',
            headers: table.headers,
            rows: table.rows,
            numericCols: table.numericCols,
            showing: table.showing,
            total: table.total,
            truncated: table.truncated,
            shapeKey: table.shapeKey,
        };
    }

    private getShellHtml(webview: vscode.Webview, initialPayload: DataViewerPayload): string {
        const nonce = createNonce();
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';`;
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
    --header-bg: var(--vscode-keybindingTable-headerBackground, var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background)));
    --rn-bg: var(--vscode-editorGutter-background, var(--vscode-sideBar-background));
    --border: var(--vscode-contrastBorder, var(--vscode-panel-border, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.25))));
    --cell-border: var(--vscode-tree-tableColumnsBorder, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.18)));
    --hover: var(--vscode-list-hoverBackground);
    --hover-fg: var(--vscode-list-hoverForeground, var(--fg));
    --stripe: var(--vscode-tree-tableOddRowsBackground, var(--vscode-keybindingTable-rowsBackground, rgba(128, 128, 128, 0.04)));
    --accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
    --muted: var(--vscode-descriptionForeground);
    --line-num: var(--vscode-editorLineNumber-foreground);
    --missing: var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--border));
    --input-placeholder: var(--vscode-input-placeholderForeground);
    --warn-fg: var(--vscode-editorWarning-foreground, var(--fg));
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    height: 100%;
    overflow: hidden;
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Consolas', monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--fg);
    background: var(--bg);
}
.empty-state {
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    text-align: center;
    color: var(--muted);
    font-family: var(--vscode-font-family, sans-serif);
}
.empty-state.active { display: flex; }
.empty-state .title { font-size: 14px; font-weight: 600; color: var(--fg); }
.empty-state .sub { margin-top: 6px; font-size: 12px; }
.viewer-root {
    display: none;
    flex-direction: column;
    height: 100vh;
}
.viewer-root.active { display: flex; }
.toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    font-family: var(--vscode-font-family, sans-serif);
}
.toolbar input {
    flex: 1;
    min-width: 140px;
    max-width: 420px;
    padding: 4px 8px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 3px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
}
.toolbar input::placeholder { color: var(--input-placeholder); }
.toolbar input:focus { border-color: var(--accent); }
.toolbar .spacer { flex: 1; }
.toolbar .info {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
}
.toolbar .truncation-badge {
    display: none;
    font-size: 11px;
    font-weight: 600;
    color: var(--warn-fg);
    border: 1px solid var(--warn-fg);
    border-radius: 3px;
    padding: 1px 6px;
    white-space: nowrap;
}
.toolbar .truncation-badge.visible { display: inline-block; }
.table-wrap {
    flex: 1;
    overflow: auto;
    position: relative;
}
table {
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    width: max-content;
    min-width: 100%;
}
thead th {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--header-bg);
    padding: 0 10px;
    height: 28px;
    line-height: 27px;
    text-align: left;
    border-bottom: 2px solid var(--border);
    border-right: 1px solid var(--cell-border);
    cursor: pointer;
    user-select: none;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
thead th.num { text-align: right; }
thead th:hover { color: var(--vscode-textLink-foreground, var(--fg)); }
thead th.rn-header {
    left: 0;
    z-index: 15;
    text-align: right;
    color: var(--line-num);
    border-right: 1px solid var(--border);
}
.arrow { font-size: 9px; margin-left: 4px; opacity: 0.85; }
tbody td {
    height: 26px;
    line-height: 25px;
    padding: 0 10px;
    border-bottom: 1px solid var(--cell-border);
    border-right: 1px solid var(--cell-border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--bg);
}
tbody td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
}
tbody td.rn {
    position: sticky;
    left: 0;
    z-index: 5;
    background: var(--rn-bg);
    color: var(--line-num);
    text-align: right;
    border-right: 1px solid var(--border);
    user-select: none;
    font-variant-numeric: tabular-nums;
}
tbody tr.odd td { background: var(--stripe); }
tbody tr.odd td.rn { background: var(--rn-bg); }
tbody tr.data-row:hover td {
    background: var(--hover);
    color: var(--hover-fg);
}
tbody tr.spacer-row td {
    padding: 0;
    border: none;
    background: transparent;
}
.missing {
    color: var(--missing);
    font-style: italic;
}
.no-matches {
    display: none;
    padding: 24px;
    text-align: center;
    color: var(--muted);
    font-family: var(--vscode-font-family, sans-serif);
}
.no-matches.visible { display: block; }
</style>
</head>
<body>
<div class="empty-state" id="emptyState">
    <div class="title">No data in memory</div>
    <div class="sub">Load a dataset in Stata and run browse to inspect observations here</div>
</div>
<div class="viewer-root" id="viewerRoot">
    <div class="toolbar">
        <input type="text" id="searchInput" placeholder="Filter observations across all columns\u2026" autocomplete="off" spellcheck="false" aria-label="Filter observations">
        <span class="info" id="matchCount"></span>
        <div class="spacer"></div>
        <span class="truncation-badge" id="truncBadge"></span>
        <span class="info" id="summaryInfo"></span>
    </div>
    <div class="table-wrap" id="tableWrap">
        <table id="dataTable">
            <colgroup id="colGroup"></colgroup>
            <thead><tr id="theadRow"></tr></thead>
            <tbody id="tbody"></tbody>
        </table>
        <div class="no-matches" id="noMatches">No matching observations</div>
    </div>
</div>
<script nonce="${escapeHtml(nonce)}">
(function() {
    const vscode = acquireVsCodeApi();
    const ROW_HEIGHT = 26;
    const OVERSCAN = 16;
    const QUANTUM = 8;
    const CHAR_PX = 8.2;
    const MIN_COL_PX = 68;
    const MAX_COL_PX = 320;
    const STRICT_NUMBER_RE = /^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$/;
    const EXT_MISSING_RE = /^\\.[a-z]$/;

    const emptyState = document.getElementById('emptyState');
    const viewerRoot = document.getElementById('viewerRoot');
    const searchInput = document.getElementById('searchInput');
    const matchCountEl = document.getElementById('matchCount');
    const truncBadgeEl = document.getElementById('truncBadge');
    const summaryInfoEl = document.getElementById('summaryInfo');
    const tableWrap = document.getElementById('tableWrap');
    const colGroup = document.getElementById('colGroup');
    const theadRow = document.getElementById('theadRow');
    const tbody = document.getElementById('tbody');
    const noMatchesEl = document.getElementById('noMatches');

    let headers = [];
    let rows = [];
    let numericCols = [];
    let showingCount = 0;
    let totalCount = 0;
    let isTruncated = false;
    let currentShapeKey = '';

    let sortCol = -1;
    let sortAsc = true;
    let searchQuery = '';
    let rowSearchCache = null;
    let viewIndices = [];

    let renderedStart = -1;
    let renderedEnd = -1;
    let rafPending = false;

    const saved = vscode.getState();
    if (saved && typeof saved === 'object') {
        if (typeof saved.shapeKey === 'string') currentShapeKey = saved.shapeKey;
        if (typeof saved.sortCol === 'number') sortCol = saved.sortCol;
        if (typeof saved.sortAsc === 'boolean') sortAsc = saved.sortAsc;
        if (typeof saved.searchQuery === 'string') {
            searchQuery = saved.searchQuery;
            searchInput.value = searchQuery;
        }
    }

    function persistState() {
        vscode.setState({
            shapeKey: currentShapeKey,
            sortCol: sortCol,
            sortAsc: sortAsc,
            searchQuery: searchQuery,
            scrollTop: tableWrap.scrollTop,
            scrollLeft: tableWrap.scrollLeft,
        });
    }

    function getMissingRank(val) {
        const t = val.trim();
        if (t === '') return 0;
        if (t === '.') return 1;
        if (EXT_MISSING_RE.test(t)) return 2 + (t.charCodeAt(1) - 97);
        return -1;
    }

    function parseStrictNum(val) {
        const t = val.trim();
        if (!STRICT_NUMBER_RE.test(t)) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
    }

    function compareStata(a, b, asc) {
        const ma = getMissingRank(a);
        const mb = getMissingRank(b);
        if (ma >= 0 || mb >= 0) {
            if (ma >= 0 && mb >= 0) return ma - mb;
            return ma >= 0 ? 1 : -1;
        }
        const na = parseStrictNum(a);
        const nb = parseStrictNum(b);
        let cmp;
        if (na !== null && nb !== null) {
            cmp = na < nb ? -1 : na > nb ? 1 : 0;
        } else if (na !== null) {
            cmp = -1;
        } else if (nb !== null) {
            cmp = 1;
        } else {
            const la = a.toLowerCase();
            const lb = b.toLowerCase();
            if (la !== lb) {
                cmp = la < lb ? -1 : 1;
            } else {
                cmp = a < b ? -1 : a > b ? 1 : 0;
            }
        }
        return asc ? cmp : -cmp;
    }

    function ensureSearchCache() {
        if (rowSearchCache !== null) return rowSearchCache;
        rowSearchCache = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            rowSearchCache[i] = rows[i].join('\\u0001').toLowerCase();
        }
        return rowSearchCache;
    }

    function recomputeView() {
        const q = searchQuery.trim().toLowerCase();
        const indices = [];
        if (q) {
            const cache = ensureSearchCache();
            for (let i = 0; i < rows.length; i++) {
                if (cache[i].indexOf(q) !== -1 || String(i + 1).indexOf(q) !== -1) {
                    indices.push(i);
                }
            }
            matchCountEl.textContent = indices.length.toLocaleString() + (indices.length === 1 ? ' match' : ' matches');
        } else {
            for (let i = 0; i < rows.length; i++) {
                indices.push(i);
            }
            matchCountEl.textContent = '';
        }

        if (sortCol >= 0 && sortCol < headers.length) {
            const col = sortCol;
            const asc = sortAsc;
            indices.sort(function(ia, ib) {
                const va = rows[ia][col] || '';
                const vb = rows[ib][col] || '';
                const c = compareStata(va, vb, asc);
                return c !== 0 ? c : ia - ib;
            });
        }

        viewIndices = indices;
        noMatchesEl.classList.toggle('visible', rows.length > 0 && viewIndices.length === 0);
        updateHeaderArrows();
        renderWindow(true);
    }

    function buildColumnsAndHeader() {
        colGroup.textContent = '';
        theadRow.textContent = '';

        const rnDigits = Math.max(3, String(rows.length).length);
        const rnWidth = Math.max(52, Math.ceil(rnDigits * CHAR_PX + 24));
        const rnCol = document.createElement('col');
        rnCol.style.width = rnWidth + 'px';
        colGroup.appendChild(rnCol);

        const rnTh = document.createElement('th');
        rnTh.className = 'rn-header';
        rnTh.textContent = '#';
        rnTh.title = 'Observation number (_n) \u2014 click to restore original order';
        rnTh.addEventListener('click', function() {
            if (sortCol !== -1) {
                sortCol = -1;
                sortAsc = true;
                persistState();
                recomputeView();
            }
        });
        theadRow.appendChild(rnTh);

        const sampleStep = Math.max(1, Math.floor(rows.length / 250));
        for (let ci = 0; ci < headers.length; ci++) {
            let maxLen = headers[ci].length + 3;
            for (let ri = 0; ri < rows.length; ri += sampleStep) {
                const cell = rows[ri][ci] || '';
                if (cell.length > maxLen) {
                    maxLen = cell.length;
                    if (maxLen >= 40) break;
                }
            }
            const widthPx = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.ceil(maxLen * CHAR_PX + 26)));
            const colEl = document.createElement('col');
            colEl.style.width = widthPx + 'px';
            colGroup.appendChild(colEl);

            const th = document.createElement('th');
            if (numericCols[ci]) th.className = 'num';
            th.setAttribute('data-col', String(ci));
            th.title = headers[ci] + ' \u2014 click to sort';

            const labelSpan = document.createElement('span');
            labelSpan.textContent = headers[ci];
            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'arrow';

            th.appendChild(labelSpan);
            th.appendChild(arrowSpan);
            th.addEventListener('click', function() {
                if (sortCol === ci) {
                    if (sortAsc) {
                        sortAsc = false;
                    } else {
                        sortCol = -1;
                        sortAsc = true;
                    }
                } else {
                    sortCol = ci;
                    sortAsc = true;
                }
                persistState();
                recomputeView();
            });
            theadRow.appendChild(th);
        }
    }

    function updateHeaderArrows() {
        const ths = theadRow.querySelectorAll('th[data-col]');
        for (let i = 0; i < ths.length; i++) {
            const col = Number(ths[i].getAttribute('data-col'));
            const arrow = ths[i].querySelector('.arrow');
            if (arrow) {
                arrow.textContent = col === sortCol ? (sortAsc ? ' \u25B2' : ' \u25BC') : '';
            }
        }
    }

    function formatSingleLineCell(val) {
        if (val.indexOf('\\n') === -1 && val.indexOf('\\r') === -1) return val;
        return val.replace(/\\r\\n|\\n|\\r/g, ' \u21B5 ');
    }

    function renderWindow(force) {
        const totalRows = viewIndices.length;
        if (totalRows === 0) {
            tbody.textContent = '';
            renderedStart = 0;
            renderedEnd = 0;
            return;
        }

        const scrollTop = tableWrap.scrollTop;
        const viewportH = tableWrap.clientHeight || 600;
        const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
        const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + 1;

        const startIdx = Math.max(0, Math.floor((firstVisible - OVERSCAN) / QUANTUM) * QUANTUM);
        const endIdx = Math.min(totalRows, startIdx + visibleCount + OVERSCAN * 2 + QUANTUM);

        if (!force && startIdx === renderedStart && endIdx === renderedEnd) {
            return;
        }
        renderedStart = startIdx;
        renderedEnd = endIdx;

        const frag = document.createDocumentFragment();
        const colSpan = headers.length + 1;

        if (startIdx > 0) {
            const topTr = document.createElement('tr');
            topTr.className = 'spacer-row';
            const topTd = document.createElement('td');
            topTd.colSpan = colSpan;
            topTd.style.height = (startIdx * ROW_HEIGHT) + 'px';
            topTr.appendChild(topTd);
            frag.appendChild(topTr);
        }

        for (let vi = startIdx; vi < endIdx; vi++) {
            const origIdx = viewIndices[vi];
            const row = rows[origIdx];
            const tr = document.createElement('tr');
            tr.className = (vi & 1) === 1 ? 'data-row odd' : 'data-row';

            const rnTd = document.createElement('td');
            rnTd.className = 'rn';
            rnTd.textContent = String(origIdx + 1);
            tr.appendChild(rnTd);

            for (let ci = 0; ci < headers.length; ci++) {
                const rawVal = row[ci] !== undefined ? row[ci] : '';
                const td = document.createElement('td');
                if (numericCols[ci]) td.className = 'num';

                const trimmed = rawVal.trim();
                if (trimmed === '.' || EXT_MISSING_RE.test(trimmed)) {
                    const span = document.createElement('span');
                    span.className = 'missing';
                    span.textContent = trimmed;
                    td.appendChild(span);
                } else {
                    const displayVal = formatSingleLineCell(rawVal);
                    td.textContent = displayVal;
                    if (rawVal.length > 34 || displayVal !== rawVal) {
                        td.title = rawVal;
                    }
                }
                tr.appendChild(td);
            }
            frag.appendChild(tr);
        }

        if (endIdx < totalRows) {
            const botTr = document.createElement('tr');
            botTr.className = 'spacer-row';
            const botTd = document.createElement('td');
            botTd.colSpan = colSpan;
            botTd.style.height = ((totalRows - endIdx) * ROW_HEIGHT) + 'px';
            botTr.appendChild(botTd);
            frag.appendChild(botTr);
        }

        tbody.textContent = '';
        tbody.appendChild(frag);
    }

    function applyPayload(payload, isInitial) {
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'empty') {
            viewerRoot.classList.remove('active');
            emptyState.classList.add('active');
            return;
        }
        if (payload.type !== 'data' || !Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
            return;
        }

        const sameShape = currentShapeKey !== '' && currentShapeKey === payload.shapeKey;
        const prevTop = sameShape ? (isInitial && saved && typeof saved.scrollTop === 'number' ? saved.scrollTop : tableWrap.scrollTop) : 0;
        const prevLeft = sameShape ? (isInitial && saved && typeof saved.scrollLeft === 'number' ? saved.scrollLeft : tableWrap.scrollLeft) : 0;

        headers = payload.headers;
        rows = payload.rows;
        numericCols = Array.isArray(payload.numericCols) ? payload.numericCols : [];
        showingCount = Number(payload.showing) || rows.length;
        totalCount = Number(payload.total) || showingCount;
        isTruncated = Boolean(payload.truncated);
        currentShapeKey = String(payload.shapeKey || '');
        rowSearchCache = null;

        if (!sameShape) {
            sortCol = -1;
            sortAsc = true;
            searchQuery = '';
            searchInput.value = '';
        }

        emptyState.classList.remove('active');
        viewerRoot.classList.add('active');

        if (isTruncated) {
            truncBadgeEl.textContent = 'Showing ' + showingCount.toLocaleString() + ' of ' + totalCount.toLocaleString() + ' obs';
            truncBadgeEl.title = 'Display is capped by stata.browseRowLimit (' + showingCount.toLocaleString() + ' rows shown)';
            truncBadgeEl.classList.add('visible');
            summaryInfoEl.textContent = headers.length.toLocaleString() + (headers.length === 1 ? ' var' : ' vars');
        } else {
            truncBadgeEl.textContent = '';
            truncBadgeEl.classList.remove('visible');
            summaryInfoEl.textContent = totalCount.toLocaleString() + ' obs \u00B7 ' + headers.length.toLocaleString() + (headers.length === 1 ? ' var' : ' vars');
        }

        buildColumnsAndHeader();
        recomputeView();

        tableWrap.scrollTop = prevTop;
        tableWrap.scrollLeft = prevLeft;
        renderWindow(true);
        persistState();
    }

    tableWrap.addEventListener('scroll', function() {
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(function() {
                rafPending = false;
                renderWindow(false);
                persistState();
            });
        }
    }, { passive: true });

    window.addEventListener('resize', function() {
        renderWindow(true);
    });

    let searchTimer = null;
    searchInput.addEventListener('input', function() {
        const val = searchInput.value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
            searchQuery = val;
            tableWrap.scrollTop = 0;
            persistState();
            recomputeView();
        }, 70);
    });

    window.addEventListener('message', function(event) {
        applyPayload(event.data, false);
    });

    const initialData = ${serializedInitial};
    applyPayload(initialData, true);
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
