import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SMCL (Stata Markup and Control Language) Viewer
 *
 * Opens .sthlp files as rendered HTML in a VS Code Webview panel,
 * similar to Markdown preview but for Stata help files.
 */

// ── SMCL → HTML Parser ────────────────────────────────────────────

interface ParseState {
    inSynoptset: boolean;
    synoptsetWidth: number;
    inP2col: boolean;
    tocEntries: { label: string; anchor: string }[];
    alsoSeeEntries: { text: string; topic: string }[];
    ulOn: boolean;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Parse SMCL content into an array of tokens. Handles nested braces properly.
 */
function findMatchingBrace(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') { depth++; }
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1; // no match
}

/**
 * Parse a single SMCL directive like {cmd:text} or {pstd}
 * Returns the directive name, optional argument after colon, and the full match length.
 */
interface SmclDirective {
    name: string;
    arg: string;    // text after the first colon (may contain nested directives)
    arg2: string;   // for directives with two arguments separated by space
    fullLength: number;
}

function parseDirective(text: string, pos: number): SmclDirective | null {
    if (text[pos] !== '{') { return null; }
    const closePos = findMatchingBrace(text, pos);
    if (closePos < 0) { return null; }

    const inner = text.substring(pos + 1, closePos);
    const fullLength = closePos - pos + 1;

    // Check for line continuation: {...} at end of line is just empty
    if (inner === '...') {
        return { name: '...', arg: '', arg2: '', fullLength };
    }

    // Comment: {* ...}
    if (inner.startsWith('*')) {
        return { name: '*', arg: '', arg2: '', fullLength };
    }

    // Find directive name (ends at colon, space, or end of inner)
    let colonPos = -1;
    let spacePos = -1;
    let braceDepth = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '{') { braceDepth++; }
        else if (inner[i] === '}') { braceDepth--; }
        else if (braceDepth === 0) {
            if (inner[i] === ':' && colonPos < 0) { colonPos = i; break; }
            if (inner[i] === ' ' && spacePos < 0) { spacePos = i; }
        }
    }

    let name: string;
    let arg = '';
    let arg2 = '';

    if (colonPos >= 0) {
        name = inner.substring(0, colonPos).trim();
        arg = inner.substring(colonPos + 1);
    } else if (spacePos >= 0) {
        name = inner.substring(0, spacePos).trim();
        const rest = inner.substring(spacePos + 1);
        // Split rest into arg and arg2 at first space (if not quoted)
        arg = rest;
        // For some directives we need to split further
        const spaceInRest = rest.indexOf(' ');
        if (spaceInRest >= 0) {
            arg = rest.substring(0, spaceInRest);
            arg2 = rest.substring(spaceInRest + 1);
        }
    } else {
        name = inner.trim();
    }

    return { name, arg, arg2, fullLength };
}

/**
 * Recursively process SMCL text, converting directives to HTML.
 */
function processSmcl(text: string, state: ParseState): string {
    let result = '';
    let i = 0;

    while (i < text.length) {
        if (text[i] === '{') {
            const directive = parseDirective(text, i);
            if (!directive) {
                result += escapeHtml('{');
                i++;
                continue;
            }

            const html = renderDirective(directive, state);
            result += html;
            i += directive.fullLength;
        } else {
            // Regular text — accumulate until next brace
            let end = text.indexOf('{', i);
            if (end < 0) { end = text.length; }
            const chunk = text.substring(i, end);
            if (state.ulOn) {
                result += `<span class="smcl-ul">${escapeHtml(chunk)}</span>`;
            } else {
                result += escapeHtml(chunk);
            }
            i = end;
        }
    }

    return result;
}

function renderDirective(d: SmclDirective, state: ParseState): string {
    const name = d.name.toLowerCase();

    // ── Text formatting ─────────────────────────────────
    switch (name) {
        case 'bf':
        case 'bold':
            return `<strong>${processSmcl(d.arg, state)}</strong>`;
        case 'it':
        case 'italic':
            return `<em>${processSmcl(d.arg, state)}</em>`;
        case 'ul':
            if (d.arg === 'on') {
                state.ulOn = true;
                return '';
            }
            if (d.arg === 'off') {
                state.ulOn = false;
                return '';
            }
            return `<span class="smcl-ul">${processSmcl(d.arg, state)}</span>`;
        case 'cmd':
            return `<code class="smcl-cmd">${processSmcl(d.arg, state)}</code>`;
        case 'opt':
            return `<code class="smcl-opt">${processSmcl(d.arg, state)}</code>`;
        case 'inp':
        case 'input':
            return `<code class="smcl-inp">${processSmcl(d.arg, state)}</code>`;
        case 'err':
        case 'error':
            return `<span class="smcl-err">${processSmcl(d.arg, state)}</span>`;
        case 'res':
        case 'result':
            return `<span class="smcl-res">${processSmcl(d.arg, state)}</span>`;
        case 'txt':
        case 'text':
            return `<span class="smcl-txt">${processSmcl(d.arg, state)}</span>`;
        case 'hi':
        case 'hilite':
            return `<span class="smcl-hi">${processSmcl(d.arg, state)}</span>`;
        case 'sf':
            return `<span class="smcl-sf">${processSmcl(d.arg, state)}</span>`;

        // ── Abbreviated command ─────────────────────────
        case 'cmdab': {
            // {cmdab:prefix:suffix} — prefix is bold cmd, suffix is normal
            const colonIdx = d.arg.indexOf(':');
            if (colonIdx >= 0) {
                const prefix = d.arg.substring(0, colonIdx);
                const suffix = d.arg.substring(colonIdx + 1);
                return `<code class="smcl-cmd"><strong>${escapeHtml(prefix)}</strong>${escapeHtml(suffix)}</code>`;
            }
            return `<code class="smcl-cmd">${escapeHtml(d.arg)}</code>`;
        }

        // ── Option with help topic ──────────────────────
        case 'opth': {
            // {opth name(help_topic)} — display as option
            const m = d.arg.match(/^(\w+)\(([^)]+)\)/);
            if (m) {
                return `<code class="smcl-opt">${escapeHtml(m[1])}(<span class="smcl-link">${escapeHtml(m[2])}</span>)</code>`;
            }
            return `<code class="smcl-opt">${processSmcl(d.arg, state)}</code>`;
        }

        // ── Structure ───────────────────────────────────
        case 'title':
            return `<h2 class="smcl-title">${processSmcl(d.arg, state)}</h2>`;

        case 'marker':
            return `<a id="${escapeHtml(d.arg)}"></a>`;

        case 'pstd':
            return `</p><p class="smcl-pstd">`;
        case 'psee':
            return `</p><p class="smcl-psee">`;
        case 'phang':
        case 'phang2':
        case 'phang3':
            return `</p><p class="smcl-phang">`;
        case 'pin':
        case 'pin2':
        case 'pin3':
            return `</p><p class="smcl-pin">`;

        case 'p': {
            // {p N N N N} — paragraph with indentation
            // Also might just be {p} (close)
            if (d.arg && /^\d/.test(d.arg)) {
                return `</p><p class="smcl-pstd">`;
            }
            return `</p><p>`;
        }
        case 'p_end':
            return `</p><p>`;

        case 'hline': {
            return `<hr class="smcl-hline">`;
        }

        case 'break':
            return `<br>`;

        case 'center':
            return `<div class="smcl-center">${processSmcl(d.arg, state)}</div>`;

        case 'col': {
            // {col N} — column positioning (approximate with spacing)
            const n = parseInt(d.arg) || 0;
            if (n > 0) {
                return `<span style="display:inline-block; min-width:${n * 0.5}em;"></span>`;
            }
            return '';
        }

        case 'space': {
            const n = parseInt(d.arg) || 1;
            let s = '';
            for (let j = 0; j < n; j++) { s += '<br>'; }
            return s;
        }

        case 'tab':
            return '&emsp;&emsp;';

        // ── Code/syntax display ─────────────────────────

        case 'synoptset': {
            state.inSynoptset = true;
            const w = parseInt(d.arg) || 20;
            state.synoptsetWidth = w;
            return `<table class="smcl-synopt-table">`;
        }

        case 'synopthdr': {
            const label = d.arg || 'Options';
            return `<tr class="smcl-synopt-hdr"><th class="smcl-synopt-col1">${escapeHtml(label)}</th><th class="smcl-synopt-col2">Description</th></tr>`;
        }

        case 'synoptline':
            return `<tr class="smcl-synopt-line"><td colspan="2"><hr></td></tr>`;

        case 'syntab':
            return `<tr class="smcl-syntab"><td colspan="2"><strong>${processSmcl(d.arg, state)}</strong></td></tr>`;

        case 'synopt': {
            // {synopt:{...}}description follows after the closing brace
            // The arg contains the option spec
            return `<tr class="smcl-synopt-row"><td class="smcl-synopt-col1">${processSmcl(d.arg, state)}</td><td class="smcl-synopt-col2">`;
        }

        // ── Two-column layout ───────────────────────────
        case 'p2colset':
            state.inP2col = true;
            return '';
        case 'p2colreset':
            state.inP2col = false;
            return '';
        case 'p2col': {
            // {p2col:{...}}text follows
            return `<div class="smcl-p2col"><div class="smcl-p2col-left">${processSmcl(d.arg, state)}</div><div class="smcl-p2col-right">`;
        }
        case 'p2line':
            return `<hr class="smcl-hline">`;

        // ── Links ───────────────────────────────────────
        case 'help': {
            const display = d.arg2 || d.arg;
            // Clean up quotes
            const cleanDisplay = display.replace(/^"(.*)"$/, '$1');
            const cleanTopic = d.arg.replace(/^"(.*)"$/, '$1').replace(/#.*/, '');
            return `<a class="smcl-link" href="#" title="help ${escapeHtml(cleanTopic)}">${processSmcl(cleanDisplay, state)}</a>`;
        }
        case 'helpb': {
            const display = d.arg2 || d.arg;
            const cleanDisplay = display.replace(/^"(.*)"$/, '$1');
            const cleanTopic = d.arg.replace(/^"(.*)"$/, '$1').replace(/#.*/, '');
            return `<a class="smcl-link smcl-link-bold" href="#" title="help ${escapeHtml(cleanTopic)}"><strong>${processSmcl(cleanDisplay, state)}</strong></a>`;
        }
        case 'manhelp': {
            // {manhelp topic MANUAL}
            const display = d.arg2 ? `[${d.arg2}] ${d.arg}` : d.arg;
            return `<a class="smcl-link smcl-link-manual" href="#" title="manual: ${escapeHtml(d.arg)}">${escapeHtml(display)}</a>`;
        }
        case 'mansection': {
            // {mansection MANUAL section}
            return `<a class="smcl-link smcl-link-manual" href="#" title="manual section">[${escapeHtml(d.arg)}] ${escapeHtml(d.arg2)}</a>`;
        }
        case 'manlink':
        case 'manlinki': {
            const display = d.arg2 ? `[${d.arg}] ${d.arg2}` : d.arg;
            return `<a class="smcl-link smcl-link-manual" href="#">${name === 'manlinki' ? '<em>' : ''}${escapeHtml(display)}${name === 'manlinki' ? '</em>' : ''}</a>`;
        }

        case 'vieweralsosee': {
            // {vieweralsosee "text" "help topic"}
            const text = d.arg.replace(/^"/, '').replace(/"$/, '');
            const topic = d.arg2.replace(/^"/, '').replace(/"$/, '');
            state.alsoSeeEntries.push({ text, topic });
            return '';
        }

        case 'viewerjumpto': {
            // {viewerjumpto "text" "topic##anchor"}
            const text = d.arg.replace(/^"/, '').replace(/"$/, '');
            let anchor = d.arg2.replace(/^"/, '').replace(/"$/, '');
            // Extract anchor from topic##anchor
            const hashIdx = anchor.indexOf('##');
            if (hashIdx >= 0) {
                anchor = anchor.substring(hashIdx + 2);
            }
            state.tocEntries.push({ label: text, anchor });
            return '';
        }

        // ── Special ─────────────────────────────────────
        case 'smcl':
        case 'com':
        case 'asis':
        case 'smcl_on':
            return '';
        case '...':
            return ''; // line continuation — newline suppressed
        case '*':
            return ''; // comment

        case 'c': {
            // {c |} {c -} etc — special characters
            const ch = (d.arg || '').trim();
            switch (ch) {
                case '|': return '|';
                case '-': return '-';
                case '+': return '+';
                case 'TLC': return '\u250C';
                case 'TRC': return '\u2510';
                case 'BLC': return '\u2514';
                case 'BRC': return '\u2518';
                case 'LT': return '\u251C';
                case 'RT': return '\u2524';
                case 'TT': return '\u252C';
                case 'BT': return '\u2534';
                case 'CT': // Removed unused variable
                case 'CRS': return '\u253C';
                default: {
                    // {c N} — character code
                    const code = parseInt(ch);
                    if (!isNaN(code)) {
                        return String.fromCharCode(code);
                    }
                    return '';
                }
            }
        }

        case 'char': {
            const code = parseInt(d.arg);
            if (!isNaN(code)) {
                return String.fromCharCode(code);
            }
            return '';
        }

        case 'stata': {
            // {stata "command"} — clickable Stata command
            return `<code class="smcl-cmd smcl-stata-link">${processSmcl(d.arg, state)}</code>`;
        }

        case 'browse': {
            // {browse "url":text} — external link
            const url = d.arg.replace(/^"(.*)"$/, '$1');
            const display = d.arg2 || url;
            return `<a class="smcl-link" href="${escapeHtml(url)}" title="${escapeHtml(url)}">${escapeHtml(display)}</a>`;
        }

        case 'bind': {
            // {bind text} — binding (just display)
            return processSmcl(d.arg, state);
        }

        case 'dlgtab':
            return `<h3 class="smcl-dlgtab">${processSmcl(d.arg, state)}</h3>`;

        case 'var':
        case 'varname':
            return `<em class="smcl-var">${processSmcl(d.arg, state)}</em>`;

        case 'depvar':
        case 'depvars':
            return `<em class="smcl-var">${processSmcl(d.arg, state)}</em>`;

        case 'indepvars':
            return `<em class="smcl-var">${processSmcl(d.arg, state)}</em>`;

        case 'ifin':
            return `<span class="smcl-txt"> [<code class="smcl-cmd">if</code>] [<code class="smcl-cmd">in</code>]</span>`;

        case 'weight':
            return `<span class="smcl-txt"> [<em>weight</em>]</span>`;

        case 'dtype':
            return `<span class="smcl-txt">${processSmcl(d.arg, state)}</span>`;

        case 'n2col':
        case 'ncol': {
            return `</p><p class="smcl-pstd">`;
        }

        case 'ralign':
        case 'right':
            return `<span style="float:right">${processSmcl(d.arg, state)}</span>`;

        case 'dup': {
            // {dup N:char} — repeat character
            const n = parseInt(d.arg) || 0;
            const ch = d.arg2 || '-';
            return escapeHtml(ch.repeat(Math.min(n, 200)));
        }

        case 'ccl':
        case 'cclopt':
            return `<code class="smcl-cmd">${processSmcl(d.arg, state)}</code>`;

        default: {
            // Unknown directive — if it has an arg, try to show it
            if (d.arg) {
                return processSmcl(d.arg, state);
            }
            // Completely unknown with no arg — just ignore
            return '';
        }
    }
}

// ── Main conversion: SMCL text → full HTML document ─────────────

function smclToHtml(smclText: string, fileName: string): string {
    const state: ParseState = {
        inSynoptset: false,
        synoptsetWidth: 20,
        inP2col: false,
        tocEntries: [],
        alsoSeeEntries: [],
        ulOn: false,
    };

    // Preprocess: handle line continuations ({...} at end of line)
    let processed = smclText.replace(/\{\.\.\.\}\s*\n/g, '');

    // Handle INCLUDE directives
    processed = processed.replace(/^INCLUDE help (\S+)/gm,
        (_match, file) => `<div class="smcl-include">[include: ${escapeHtml(file)}]</div>`);

    // Split into lines and process
    const lines = processed.split('\n');
    const bodyParts: string[] = [];
    let inSynoptTable = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip {smcl} and empty markers
        if (trimmed === '{smcl}' || trimmed === '{* *! ...}' || trimmed === '') {
            // Keep blank lines as spacing
            if (trimmed === '') {
                bodyParts.push('<div class="smcl-blank"></div>');
            }
            continue;
        }

        // Track synopt table state for closing
        if (trimmed.startsWith('{synoptset')) {
            inSynoptTable = true;
        }
        if (trimmed === '{synoptset}' || (inSynoptTable && trimmed === '{p2colreset}')) {
            if (inSynoptTable) {
                bodyParts.push('</table>');
                inSynoptTable = false;
            }
        }

        // Process the line
        const html = processSmcl(line, state);
        if (html.trim()) {
            bodyParts.push(html);
        }
    }

    // Close any remaining synopt table
    if (inSynoptTable) {
        bodyParts.push('</table>');
    }

    // Build TOC if we have entries
    let tocHtml = '';
    if (state.tocEntries.length > 0) {
        tocHtml = `<nav class="smcl-toc"><ul>`;
        for (const entry of state.tocEntries) {
            tocHtml += `<li><a href="#${escapeHtml(entry.anchor)}">${escapeHtml(entry.label)}</a></li>`;
        }
        tocHtml += `</ul></nav>`;
    }

    // Build "Also see" section
    let alsoSeeHtml = '';
    if (state.alsoSeeEntries.length > 0) {
        alsoSeeHtml = `<div class="smcl-alsosee"><h3>Also see</h3><ul>`;
        for (const entry of state.alsoSeeEntries) {
            alsoSeeHtml += `<li><a class="smcl-link" href="#" title="${escapeHtml(entry.topic)}">${escapeHtml(entry.text)}</a></li>`;
        }
        alsoSeeHtml += `</ul></div>`;
    }

    const baseName = path.basename(fileName, path.extname(fileName));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
${getStyles()}
</style>
</head>
<body>
<div class="smcl-container">
    <header class="smcl-header">
        <span class="smcl-header-title">${escapeHtml(baseName)}</span>
        <span class="smcl-header-subtitle">Stata Help File</span>
    </header>
    ${tocHtml}
    <div class="smcl-body">
        ${bodyParts.join('\n')}
    </div>
    ${alsoSeeHtml}
</div>
</body>
</html>`;
}

function getStyles(): string {
    return `
:root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --fg-dim: var(--vscode-descriptionForeground, #888888);
    --border: var(--vscode-panel-border, #2d2d2d);
    --link: var(--vscode-textLink-foreground, #4daafc);
    --link-hover: var(--vscode-textLink-activeForeground, #74c0fc);
    --code-bg: var(--vscode-textCodeBlock-background, #2a2a2a);
    --code-fg: var(--vscode-textPreformat-foreground, #d4d4d4);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #ffffff);
    --heading-fg: var(--vscode-editor-foreground, #cccccc);
    --table-border: var(--vscode-panel-border, #333333);
    --table-header-bg: var(--vscode-editorWidget-background, #252526);
    --highlight-bg: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 178, 0, 0.22));
    --error-fg: var(--vscode-errorForeground, #f44747);
    --result-fg: var(--vscode-terminal-ansiGreen, #6a9955);
    --input-fg: var(--vscode-terminal-ansiYellow, #dcdcaa);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    font-size: 14px;
    line-height: 1.65;
    padding: 0;
    -webkit-font-smoothing: antialiased;
}

.smcl-container {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 32px 48px;
}

/* ── Header ───────────────────────────────────────── */
.smcl-header {
    padding-bottom: 16px;
    margin-bottom: 16px;
    border-bottom: 2px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 12px;
}
.smcl-header-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--heading-fg);
    letter-spacing: -0.02em;
}
.smcl-header-subtitle {
    font-size: 12px;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
}

/* ── Table of contents ────────────────────────────── */
.smcl-toc {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 20px;
    margin-bottom: 24px;
}
.smcl-toc ul {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
}
.smcl-toc li { }
.smcl-toc a {
    color: var(--link);
    text-decoration: none;
    font-size: 13px;
    padding: 2px 0;
}
.smcl-toc a:hover {
    color: var(--link-hover);
    text-decoration: underline;
}

/* ── Body text ────────────────────────────────────── */
.smcl-body {
    line-height: 1.7;
}
.smcl-body > p, .smcl-body > div {
    margin-bottom: 2px;
}
.smcl-blank {
    height: 6px;
}

/* ── Headings ─────────────────────────────────────── */
h2.smcl-title {
    font-size: 17px;
    font-weight: 700;
    color: var(--heading-fg);
    margin-top: 28px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
    letter-spacing: -0.01em;
}
h3.smcl-dlgtab {
    font-size: 15px;
    font-weight: 600;
    color: var(--heading-fg);
    margin-top: 20px;
    margin-bottom: 8px;
}

/* ── Paragraphs ───────────────────────────────────── */
p.smcl-pstd {
    margin: 6px 0;
    padding-left: 16px;
}
p.smcl-phang {
    margin: 4px 0;
    padding-left: 32px;
    text-indent: -16px;
}
p.smcl-pin {
    margin: 4px 0;
    padding-left: 48px;
}
p.smcl-psee {
    margin: 4px 0;
    padding-left: 16px;
}

/* ── Inline styles ────────────────────────────────── */
code.smcl-cmd {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, monospace);
    font-size: 13px;
    color: var(--link);
    background: transparent;
    padding: 0;
}
code.smcl-opt {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, monospace);
    font-size: 13px;
    color: var(--code-fg);
}
code.smcl-inp {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, monospace);
    font-size: 13px;
    color: var(--input-fg);
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 3px;
}
.smcl-ul {
    text-decoration: underline;
    text-underline-offset: 2px;
}
.smcl-err {
    color: var(--error-fg);
    font-weight: 600;
}
.smcl-res {
    color: var(--result-fg);
}
.smcl-txt {
    color: var(--fg);
}
.smcl-hi {
    background: var(--highlight-bg);
    padding: 1px 4px;
    border-radius: 2px;
}
.smcl-sf {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
}
.smcl-var {
    font-style: italic;
    color: var(--fg);
}
.smcl-stata-link {
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 3px;
}

/* ── Horizontal rule ──────────────────────────────── */
hr.smcl-hline {
    border: none;
    border-top: 1px solid var(--border);
    margin: 12px 0;
}

/* ── Center ───────────────────────────────────────── */
.smcl-center {
    text-align: center;
    margin: 8px 0;
}

/* ── Links ────────────────────────────────────────── */
a.smcl-link {
    color: var(--link);
    text-decoration: none;
    cursor: pointer;
}
a.smcl-link:hover {
    color: var(--link-hover);
    text-decoration: underline;
}
a.smcl-link-bold {
    font-weight: 700;
}
a.smcl-link-manual {
    font-style: italic;
}

/* ── Synopt table (options) ───────────────────────── */
table.smcl-synopt-table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 13.5px;
}
tr.smcl-synopt-hdr th {
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    padding: 8px 12px;
    background: var(--table-header-bg);
    border-bottom: 2px solid var(--table-border);
}
th.smcl-synopt-col1 {
    width: 40%;
    min-width: 180px;
}
tr.smcl-synopt-line td {
    padding: 0;
}
tr.smcl-synopt-line hr {
    border: none;
    border-top: 1px solid var(--table-border);
    margin: 0;
}
tr.smcl-syntab td {
    padding: 10px 12px 4px;
    color: var(--heading-fg);
    font-size: 14px;
    border-bottom: 1px solid var(--table-border);
}
tr.smcl-synopt-row td {
    padding: 5px 12px;
    vertical-align: top;
    border-bottom: 1px solid rgba(128,128,128,0.1);
}
td.smcl-synopt-col1 {
    width: 40%;
    min-width: 180px;
    white-space: nowrap;
}

/* ── Two-column layout ────────────────────────────── */
.smcl-p2col {
    display: flex;
    gap: 16px;
    margin: 4px 0;
    padding: 4px 0;
}
.smcl-p2col-left {
    min-width: 200px;
    flex-shrink: 0;
}
.smcl-p2col-right {
    flex: 1;
}

/* ── Also see ─────────────────────────────────────── */
.smcl-alsosee {
    margin-top: 36px;
    padding-top: 16px;
    border-top: 2px solid var(--border);
}
.smcl-alsosee h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 10px;
}
.smcl-alsosee ul {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
}
.smcl-alsosee a {
    font-size: 13px;
}

/* ── Include notice ───────────────────────────────── */
.smcl-include {
    color: var(--fg-dim);
    font-size: 12px;
    font-style: italic;
    padding: 4px 0;
}

/* ── Responsive ───────────────────────────────────── */
@media (max-width: 600px) {
    .smcl-container { padding: 16px; }
    .smcl-p2col { flex-direction: column; gap: 4px; }
    td.smcl-synopt-col1, th.smcl-synopt-col1 { min-width: 120px; width: 35%; }
}
`;
}

// ── VS Code integration ─────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

export function openSthlpPreview(fileUri?: vscode.Uri): void {
    // Determine which file to preview
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
    const smclText = fs.readFileSync(filePath, 'utf-8');
    const html = smclToHtml(smclText, fileName);

    if (currentPanel) {
        currentPanel.title = `Preview: ${fileName}`;
        currentPanel.webview.html = html;
        currentPanel.reveal(vscode.ViewColumn.Beside, true);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'stataSthlpPreview',
            `Preview: ${fileName}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: false,
                enableCommandUris: false,
                localResourceRoots: [],
            }
        );
        currentPanel.webview.html = html;
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        });
    }
}

/**
 * Register the SMCL preview command and auto-preview behavior.
 */
export function registerSthlpViewer(context: vscode.ExtensionContext): void {
    // Command: open preview
    context.subscriptions.push(
        vscode.commands.registerCommand('stata.previewSthlp', (uri?: vscode.Uri) => {
            openSthlpPreview(uri);
        })
    );

    // Auto-show a "Preview" CodeLens-like button in the editor title for .sthlp files
    // We use editor/title menu contribution (registered in package.json)

    // Watch for .sthlp file opens and offer preview
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.fileName.endsWith('.sthlp')) {
                // Set context so the preview button shows in the editor title
                vscode.commands.executeCommand('setContext', 'stata.isSthlpFile', true);
            } else {
                vscode.commands.executeCommand('setContext', 'stata.isSthlpFile', false);
            }
        })
    );

    // Set initial context for the currently active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.fileName.endsWith('.sthlp')) {
        vscode.commands.executeCommand('setContext', 'stata.isSthlpFile', true);
    }
}
