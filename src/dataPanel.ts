import * as vscode from 'vscode';
import * as fs from 'fs';

export class DataPanel {
    private panel: vscode.WebviewPanel | undefined;
    private tempDir: string;

    constructor(tempDir: string) {
        this.tempDir = tempDir;
    }

    show(csvPath: string, totalObs?: number): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'stataData',
                'Stata Data Viewer',
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.file(this.tempDir)],
                }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }

        // Empty state — no data in memory
        if (!csvPath || !fs.existsSync(csvPath)) {
            this.panel.title = 'Data Viewer';
            this.panel.webview.html = this.getEmptyHtml();
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }

        const data = this.parseCsv(csvPath);
        if (data.headers.length === 0) {
            this.panel.title = 'Data Viewer';
            this.panel.webview.html = this.getEmptyHtml();
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }

        const showing = data.rows.length;
        const total = totalObs ?? showing;
        this.panel.title = `Data Viewer (${total.toLocaleString()} obs)`;
        this.panel.webview.html = this.getHtml(data, showing, total);
        this.panel.reveal(vscode.ViewColumn.Active, false);
    }

    private getEmptyHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-descriptionForeground, #888);
    background: var(--vscode-editor-background, #1e1e1e);
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    text-align: center;
}
.empty { font-size: 14px; }
.empty .icon { font-size: 48px; margin-bottom: 12px; opacity: 0.3; }
</style>
</head>
<body>
<div class="empty">
    <div class="icon">&#x1F4CB;</div>
    <div>No data in memory</div>
    <div style="margin-top:6px;font-size:11px;">Load a dataset to browse it here</div>
</div>
</body>
</html>`;
    }

    private parseCsv(csvPath: string): { headers: string[]; rows: string[][]; numericCols: boolean[] } {
        const content = fs.readFileSync(csvPath, 'utf-8');
        const lines = this.splitCsvLines(content);
        if (lines.length === 0) {
            return { headers: [], rows: [], numericCols: [] };
        }
        const rowLimit = vscode.workspace.getConfiguration('stata').get<number>('browseRowLimit', 10000);
        const headers = this.parseCsvLine(lines[0]);
        const rows: string[][] = [];
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '') { continue; }
            if (rows.length >= rowLimit) { break; }
            rows.push(this.parseCsvLine(lines[i]));
        }
        // Detect numeric columns by sampling first 20 rows
        const numericCols = headers.map((_, ci) => {
            let numCount = 0, total = 0;
            for (let ri = 0; ri < Math.min(rows.length, 20); ri++) {
                const val = (rows[ri][ci] || '').trim();
                if (val === '' || val === '.') { continue; }
                total++;
                if (!isNaN(parseFloat(val))) { numCount++; }
            }
            return total > 0 && numCount / total > 0.8;
        });
        return { headers, rows, numericCols };
    }

    private splitCsvLines(content: string): string[] {
        const lines: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < content.length; i++) {
            const ch = content[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
                current += ch;
            } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
                if (ch === '\r' && content[i + 1] === '\n') { i++; }
                lines.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim() !== '') {
            lines.push(current);
        }
        return lines;
    }

    private parseCsvLine(line: string): string[] {
        const fields: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current);
        return fields;
    }

    private getHtml(data: { headers: string[]; rows: string[][]; numericCols: boolean[] }, showing: number, total: number): string {
        const nonce = getNonce();
        const { headers, rows, numericCols } = data;
        const truncated = showing < total;

        const headerCells = headers.map((h, i) => {
            const align = numericCols[i] ? ' class="num"' : '';
            return `<th data-col="${i}"${align} onclick="sortBy(${i})">${esc(h)}<span class="arrow"></span></th>`;
        }).join('');

        const bodyRows = rows.map((row, ri) => {
            const cells = row.map((cell, ci) => {
                const cls = numericCols[ci] ? ' class="num"' : '';
                const val = cell === '.' ? '<span class="missing">.</span>' : esc(cell);
                return `<td${cls}>${val}</td>`;
            }).join('');
            return `<tr><td class="rn">${ri + 1}</td>${cells}</tr>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #ccc);
    --header-bg: var(--vscode-sideBar-background, #252526);
    --border: var(--vscode-panel-border, #333);
    --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    --stripe: rgba(255,255,255,0.025);
    --accent: var(--vscode-textLink-foreground, #4daafc);
    --line-num: var(--vscode-editorLineNumber-foreground, #858585);
    --missing: var(--vscode-editorGhostText-foreground, #666);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Consolas', monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--fg);
    background: var(--bg);
    line-height: 1.5;
}
.toolbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
}
.toolbar input {
    flex: 1;
    padding: 3px 8px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
    outline: none;
}
.toolbar input:focus { border-color: var(--accent); }
.toolbar .info {
    font-size: 11px;
    color: var(--line-num);
    white-space: nowrap;
}
.table-wrap {
    overflow: auto;
    max-height: calc(100vh - 38px);
}
table { border-collapse: collapse; width: 100%; }
thead { position: sticky; top: 0; z-index: 10; }
th {
    background: var(--header-bg);
    padding: 5px 12px;
    text-align: left;
    border-bottom: 2px solid var(--border);
    cursor: pointer;
    user-select: none;
    font-weight: 600;
    white-space: nowrap;
}
th.num { text-align: right; }
th:hover { color: var(--accent); }
.arrow { font-size: 9px; margin-left: 3px; opacity: 0.4; }
td {
    padding: 2px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
}
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.rn {
    color: var(--line-num);
    text-align: right;
    padding-right: 12px;
    border-right: 1px solid var(--border);
    user-select: none;
    width: 1%;
}
th.rn-header {
    cursor: default;
    width: 1%;
    border-right: 1px solid var(--border);
}
tr:nth-child(even) td { background: var(--stripe); }
tr:hover td { background: var(--hover); }
.missing { color: var(--missing); font-style: italic; }
tr.hidden { display: none; }
</style>
</head>
<body>
<div class="toolbar">
    <input type="text" id="search" placeholder="Search across all columns\u2026" autocomplete="off" spellcheck="false">
    <span class="info" id="matchCount"></span>
    <div class="info">
        ${truncated
            ? `${showing.toLocaleString()} of ${total.toLocaleString()} obs`
            : `${total.toLocaleString()} obs`
        } \u00B7 ${headers.length} vars
    </div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th class="rn-header">#</th>${headerCells}</tr></thead>
<tbody id="tbody">
${bodyRows}
</tbody>
</table>
</div>
<script nonce="${nonce}">
(function() {
    let sortCol = -1, sortAsc = true;
    const tbody = document.getElementById('tbody');
    const searchInput = document.getElementById('search');

    window.sortBy = function(col) {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
        rows.sort((a, b) => {
            const aVal = a.children[col + 1]?.textContent || '';
            const bVal = b.children[col + 1]?.textContent || '';
            const aNum = parseFloat(aVal), bNum = parseFloat(bVal);
            const cmp = (!isNaN(aNum) && !isNaN(bNum)) ? aNum - bNum : aVal.localeCompare(bVal);
            return sortAsc ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
        document.querySelectorAll('.arrow').forEach(el => el.textContent = '');
        const th = document.querySelector('th[data-col="' + col + '"] .arrow');
        if (th) th.textContent = sortAsc ? ' \u25B2' : ' \u25BC';
    };

    const matchEl = document.getElementById('matchCount');
    searchInput.addEventListener('input', function() {
        const q = this.value.toLowerCase();
        const rows = tbody.querySelectorAll('tr');
        let visible = 0;
        rows.forEach(r => {
            if (!q) { r.classList.remove('hidden'); visible++; return; }
            const text = r.textContent.toLowerCase();
            const match = text.includes(q);
            r.classList.toggle('hidden', !match);
            if (match) visible++;
        });
        matchEl.textContent = q ? visible + ' matches' : '';
    });
})();
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
