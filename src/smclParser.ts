import * as path from 'path';
import { crossPlatformBasename, escapeHtml, sanitizeExternalUrl } from './htmlUtils';

export interface PathLike {
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    extname(p: string): string;
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
    isAbsolute(p: string): boolean;
}

export interface SmclRenderOptions {
    nonce?: string;
    cspSource?: string;
    currentFilePath?: string;
    includeResolver?: (includeTopic: string) => string | undefined;
    initialAnchor?: string;
}

export interface ParsedHelpTarget {
    topic: string;
    anchor: string;
}

export type BrowseResolution =
    | { kind: 'external'; url: string }
    | { kind: 'localFile'; filePath: string }
    | { kind: 'blocked' };

const SAFE_TOPIC_RE = /^[A-Za-z0-9_.-]+$/;
const SAFE_LOCAL_DOC_EXT_RE = /^\.(?:do|ado|mata|sthlp|hlp|ihlp|smcl|txt|md|csv|tsv|log|dta)$/i;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]+:/;
const WIN_DRIVE_RE = /^[A-Za-z]:[/\\]/;

interface ParseState {
    inSynoptset: boolean;
    synoptsetWidth: number;
    inP2col: boolean;
    openBlock: 'p' | 'synopt' | 'p2col' | null;
    tocEntries: { label: string; anchor: string }[];
    alsoSeeEntries: { text: string; topic: string }[];
    ulOn: boolean;
}

export interface SmclDirective {
    name: string;
    arg: string;
    arg2: string;
    hasColonAfterName: boolean;
    fullLength: number;
}

function stripOuterQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

export function findMatchingBrace(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') {
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Split a string at the first top-level `:` (outside `{...}`, `"..."`, and `(...)`).
 */
function splitAtTopLevelColon(input: string, ignoreParens = false): [string, string | null] {
    let braceDepth = 0;
    let parenDepth = 0;
    let inQuotes = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '"' && braceDepth === 0) {
            inQuotes = !inQuotes;
        } else if (!inQuotes) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
            } else if (!ignoreParens && ch === '(') {
                parenDepth++;
            } else if (!ignoreParens && ch === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
            } else if (ch === ':' && braceDepth === 0 && parenDepth === 0) {
                return [input.slice(0, i), input.slice(i + 1)];
            }
        }
    }
    return [input, null];
}

/**
 * Parse space-separated tokens respecting double quotes and nested `{...}`.
 */
function splitQuotedTokens(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let braceDepth = 0;
    let hasToken = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '"' && braceDepth === 0) {
            inQuotes = !inQuotes;
            hasToken = true;
            continue;
        }
        if (!inQuotes) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
            } else if ((ch === ' ' || ch === '\t' || ch === '\n') && braceDepth === 0) {
                if (hasToken || current.length > 0) {
                    tokens.push(current);
                    current = '';
                    hasToken = false;
                }
                continue;
            }
        }
        current += ch;
        hasToken = true;
    }

    if (hasToken || current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

export function parseDirective(text: string, pos: number): SmclDirective | null {
    if (text[pos] !== '{') {
        return null;
    }
    const closePos = findMatchingBrace(text, pos);
    if (closePos < 0) {
        return null;
    }

    const inner = text.substring(pos + 1, closePos);
    const fullLength = closePos - pos + 1;

    if (inner === '...') {
        return { name: '...', arg: '', arg2: '', hasColonAfterName: false, fullLength };
    }

    if (inner.startsWith('*')) {
        return { name: '*', arg: '', arg2: '', hasColonAfterName: false, fullLength };
    }

    // Skip leading whitespace before directive name
    let idx = 0;
    while (idx < inner.length && (inner[idx] === ' ' || inner[idx] === '\t' || inner[idx] === '\n')) {
        idx++;
    }

    const nameStart = idx;
    while (
        idx < inner.length &&
        inner[idx] !== ':' &&
        inner[idx] !== ' ' &&
        inner[idx] !== '\t' &&
        inner[idx] !== '\n' &&
        inner[idx] !== '{' &&
        inner[idx] !== '}'
    ) {
        idx++;
    }

    const name = inner.substring(nameStart, idx).trim();
    if (!name) {
        return { name: '', arg: inner, arg2: '', hasColonAfterName: false, fullLength };
    }

    // Skip spaces/tabs between directive name and potential colon (e.g. `{synopt :{opt ...}}`)
    let afterName = idx;
    while (afterName < inner.length && (inner[afterName] === ' ' || inner[afterName] === '\t')) {
        afterName++;
    }

    if (afterName < inner.length && inner[afterName] === ':') {
        const arg = inner.substring(afterName + 1);
        return { name, arg, arg2: '', hasColonAfterName: true, fullLength };
    }

    // Space-separated arguments after directive name
    const rest = inner.substring(afterName);
    if (!rest) {
        return { name, arg: '', arg2: '', hasColonAfterName: false, fullLength };
    }

    // Split rest at first top-level space (respecting quotes and braces) for arg / arg2 compatibility
    let splitSpace = -1;
    let inQuotes = false;
    let braceDepth = 0;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '"' && braceDepth === 0) {
            inQuotes = !inQuotes;
        } else if (!inQuotes) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
            } else if ((ch === ' ' || ch === '\t') && braceDepth === 0) {
                splitSpace = i;
                break;
            }
        }
    }

    if (splitSpace >= 0) {
        return {
            name,
            arg: rest,
            arg2: rest.substring(splitSpace + 1).trim(),
            hasColonAfterName: false,
            fullLength,
        };
    }

    return { name, arg: rest, arg2: '', hasColonAfterName: false, fullLength };
}

function closeOpenBlock(state: ParseState): string {
    if (state.openBlock === 'p') {
        state.openBlock = null;
        return '</p>';
    }
    if (state.openBlock === 'synopt') {
        state.openBlock = null;
        return '</td></tr>';
    }
    if (state.openBlock === 'p2col') {
        state.openBlock = null;
        return '</div></div>';
    }
    return '';
}

function openParagraph(cls: string, state: ParseState): string {
    const prefix = closeOpenBlock(state);
    state.openBlock = 'p';
    return cls ? `${prefix}<p class="${cls}">` : `${prefix}<p>`;
}

function safeCharFromCode(raw: string): string {
    const code = parseInt(raw.trim(), 10);
    if (!Number.isInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0x7f) {
        return '';
    }
    return escapeHtml(String.fromCodePoint(code));
}

/**
 * Parse and validate a Stata help link target such as `regress`, `regress postestimation`,
 * `regress##options`, `##syntax`, or `help regress`.
 * Rejects path traversal (`..`, `/`, `\`, `:`) so untrusted SMCL cannot escape help directories.
 */
export function parseHelpTarget(rawTarget: string): ParsedHelpTarget | null {
    let cleaned = stripOuterQuotes(rawTarget).trim();
    if (!cleaned || cleaned === '--') {
        return null;
    }
    if (/^help\s+/i.test(cleaned)) {
        cleaned = cleaned.replace(/^help\s+/i, '').trim();
    }
    if (/^mansection\s+/i.test(cleaned)) {
        return null;
    }

    let topicPart = cleaned;
    let anchor = '';
    const doubleHash = cleaned.indexOf('##');
    if (doubleHash >= 0) {
        topicPart = cleaned.slice(0, doubleHash).trim();
        anchor = cleaned.slice(doubleHash + 2).trim();
    } else {
        const singleHash = cleaned.indexOf('#');
        if (singleHash >= 0) {
            topicPart = cleaned.slice(0, singleHash).trim();
            anchor = cleaned.slice(singleHash + 1).trim();
        }
    }

    // Strip any trailing option parens in anchor like `level()` -> keep `level()` as anchor ID, validate topic
    if (topicPart === '') {
        return anchor ? { topic: '', anchor } : null;
    }

    // Multi-word Stata help topics map spaces to underscores (e.g. `regress postestimation` -> `regress_postestimation`)
    const normalizedTopic = topicPart.replace(/\s+/g, '_').replace(/%+$/, '');
    if (!normalizedTopic || normalizedTopic.includes('..') || !SAFE_TOPIC_RE.test(normalizedTopic)) {
        return null;
    }

    return { topic: normalizedTopic, anchor };
}

/**
 * Build cross-platform candidate file paths for a Stata `.sthlp` / `.hlp` / `.ihlp` topic
 * using the provided path implementation (`path` by default, or `path.win32` / `path.posix` in tests).
 */
export function buildHelpFileCandidates(
    topic: string,
    options: {
        currentFilePath?: string;
        searchRoots?: readonly string[];
        extensions?: readonly string[];
        pathImpl?: PathLike;
    } = {},
): string[] {
    const parsed = parseHelpTarget(topic);
    if (!parsed || !parsed.topic) {
        return [];
    }

    const p = options.pathImpl ?? path;
    const exts = options.extensions ?? ['.sthlp', '.hlp'];
    const cleanTopic = parsed.topic;
    const firstChar = cleanTopic.charAt(0).toLowerCase();
    const candidates: string[] = [];
    const seen = new Set<string>();

    const addCandidate = (filePath: string): void => {
        if (!seen.has(filePath)) {
            seen.add(filePath);
            candidates.push(filePath);
        }
    };

    const addDirCandidates = (dir: string): void => {
        if (!dir) {
            return;
        }
        for (const ext of exts) {
            addCandidate(p.join(dir, `${cleanTopic}${ext}`));
        }
        if (firstChar) {
            for (const ext of exts) {
                addCandidate(p.join(dir, firstChar, `${cleanTopic}${ext}`));
            }
        }
    };

    if (options.currentFilePath) {
        const currentDir = p.dirname(options.currentFilePath);
        for (const ext of exts) {
            addCandidate(p.join(currentDir, `${cleanTopic}${ext}`));
        }

        const dirName = p.basename(currentDir);
        const parentDir = p.dirname(currentDir);
        // If current file is inside an ado letter folder (`.../ado/base/r/regress.sthlp`), check sibling letter folder
        if (dirName.length === 1 && parentDir && parentDir !== currentDir) {
            addDirCandidates(parentDir);
            const adoParent = p.dirname(parentDir);
            if (p.basename(adoParent).toLowerCase() === 'ado') {
                addDirCandidates(p.join(adoParent, 'base'));
                addDirCandidates(p.join(adoParent, 'plus'));
                addDirCandidates(p.join(adoParent, 'personal'));
            }
        } else if (parentDir && parentDir !== currentDir) {
            addDirCandidates(parentDir);
        }
    }

    if (options.searchRoots) {
        for (const root of options.searchRoots) {
            if (!root) {
                continue;
            }
            addDirCandidates(root);
            addDirCandidates(p.join(root, 'ado', 'base'));
            addDirCandidates(p.join(root, 'ado', 'plus'));
        }
    }

    return candidates;
}

/**
 * Derive Stata installation root directories that may contain `ado/base` from a resolved Stata binary path,
 * handling Windows (`C:\Program Files\Stata18\StataMP-64.exe`), macOS (`.../StataMP.app/Contents/MacOS/stata-mp`),
 * and Linux (`/usr/local/stata18/stata-mp`).
 */
export function deriveStataInstallRoots(stataExecutablePath: string, pathImpl: PathLike = path): string[] {
    if (!stataExecutablePath) {
        return [];
    }
    const roots: string[] = [];
    const exeDir = pathImpl.dirname(stataExecutablePath);
    roots.push(exeDir);

    // macOS bundle: /Applications/StataNow/StataMP.app/Contents/MacOS/stata-mp -> /Applications/StataNow
    const macOsDir = pathImpl.basename(exeDir).toLowerCase();
    const contentsDir = pathImpl.dirname(exeDir);
    if (macOsDir === 'macos' && pathImpl.basename(contentsDir).toLowerCase() === 'contents') {
        const appBundleDir = pathImpl.dirname(contentsDir);
        const installDir = pathImpl.dirname(appBundleDir);
        if (installDir && installDir !== appBundleDir) {
            roots.push(installDir);
        }
    }

    const parentDir = pathImpl.dirname(exeDir);
    if (parentDir && parentDir !== exeDir) {
        roots.push(parentDir);
    }

    return Array.from(new Set(roots));
}

/**
 * Safely classify and resolve a `{browse ...}` target on Windows/macOS/Linux.
 * - Allows `http://`, `https://`, `mailto:` external links.
 * - Allows relative or local safe non-executable document files (`.do`, `.sthlp`, `.dta`, `.csv`, etc.),
 *   normalizing `/` and `\` via `pathImpl`.
 * - Blocks `javascript:`, `command:`, `vscode:`, `data:`, `vbscript:`, `file:`, and executable files (`.exe`, `.bat`, `.cmd`, `.ps1`).
 */
export function resolveBrowseTarget(
    rawTarget: string,
    currentFilePath?: string,
    pathImpl: PathLike = path,
): BrowseResolution {
    const cleaned = stripOuterQuotes(rawTarget).trim();
    if (!cleaned) {
        return { kind: 'blocked' };
    }

    const safeExternal = sanitizeExternalUrl(cleaned);
    if (safeExternal) {
        return { kind: 'external', url: safeExternal };
    }

    // Bare `www.example.com...` often appears in older Stata help files
    if (/^www\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/\S*)?$/i.test(cleaned)) {
        const withHttps = sanitizeExternalUrl(`https://${cleaned}`);
        if (withHttps) {
            return { kind: 'external', url: withHttps };
        }
    }

    // Block any URI scheme (except Windows drive letters like `C:\...` or `D:/...`)
    if (!WIN_DRIVE_RE.test(cleaned) && URI_SCHEME_RE.test(cleaned)) {
        return { kind: 'blocked' };
    }

    // Candidate local/relative file path — allow only safe document extensions, never executables
    const ext = pathImpl.extname(cleaned);
    if (!SAFE_LOCAL_DOC_EXT_RE.test(ext)) {
        return { kind: 'blocked' };
    }

    // Normalize separators for the target path implementation
    const isWinStyle = WIN_DRIVE_RE.test(cleaned) || (currentFilePath ? WIN_DRIVE_RE.test(currentFilePath) : false);
    const normalizedRel = isWinStyle ? cleaned.replace(/\//g, '\\') : cleaned.replace(/\\/g, '/');

    if (pathImpl.isAbsolute(normalizedRel)) {
        return { kind: 'localFile', filePath: normalizedRel };
    }

    if (currentFilePath) {
        const baseDir = pathImpl.dirname(currentFilePath);
        return { kind: 'localFile', filePath: pathImpl.resolve(baseDir, normalizedRel) };
    }

    return { kind: 'blocked' };
}

function renderAbbrevOption(spec: string, state: ParseState): string {
    // Handles `{opt nocons:tant}` or `{opt l:evel(#)}` where prefix before `:` is underlined minimum abbreviation
    const parenIdx = spec.indexOf('(');
    const head = parenIdx >= 0 ? spec.slice(0, parenIdx) : spec;
    const tail = parenIdx >= 0 ? spec.slice(parenIdx) : '';
    const colonIdx = head.indexOf(':');
    if (colonIdx >= 0) {
        const prefix = head.slice(0, colonIdx);
        const suffix = head.slice(colonIdx + 1);
        return `<code class="smcl-opt"><span class="smcl-ul">${processSmcl(prefix, state)}</span>${processSmcl(suffix + tail, state)}</code>`;
    }
    return `<code class="smcl-opt">${processSmcl(spec, state)}</code>`;
}

function renderHelpAnchorTag(
    rawTarget: string,
    displayHtml: string,
    extraClass: string,
    titlePrefix: string,
): string {
    const parsed = parseHelpTarget(rawTarget);
    if (!parsed) {
        return `<span class="smcl-link ${extraClass}">${displayHtml}</span>`;
    }
    if (!parsed.topic && parsed.anchor) {
        return `<a class="smcl-link ${extraClass}" href="#${escapeHtml(parsed.anchor)}" data-anchor="${escapeHtml(parsed.anchor)}">${displayHtml}</a>`;
    }
    const targetAttr = parsed.anchor ? `${parsed.topic}##${parsed.anchor}` : parsed.topic;
    const href = `#`;
    return `<a class="smcl-link ${extraClass}" href="${href}" data-help="${escapeHtml(targetAttr)}" title="${escapeHtml(titlePrefix + parsed.topic)}">${displayHtml}</a>`;
}

function processSmcl(text: string, state: ParseState, currentFilePath?: string): string {
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

            result += renderDirective(directive, state, currentFilePath);
            i += directive.fullLength;
        } else {
            let end = text.indexOf('{', i);
            if (end < 0) {
                end = text.length;
            }
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

function renderDirective(d: SmclDirective, state: ParseState, currentFilePath?: string): string {
    const name = d.name.toLowerCase();

    switch (name) {
        case 'bf':
        case 'bold':
            return `<strong>${processSmcl(d.arg, state, currentFilePath)}</strong>`;
        case 'it':
        case 'italic':
            return `<em>${processSmcl(d.arg, state, currentFilePath)}</em>`;
        case 'ul': {
            const argTrim = d.arg.trim().toLowerCase();
            if (!d.hasColonAfterName && argTrim === 'on') {
                state.ulOn = true;
                return '';
            }
            if (!d.hasColonAfterName && argTrim === 'off') {
                state.ulOn = false;
                return '';
            }
            return `<span class="smcl-ul">${processSmcl(d.arg, state, currentFilePath)}</span>`;
        }
        case 'cmd':
            return `<code class="smcl-cmd">${processSmcl(d.arg, state, currentFilePath)}</code>`;
        case 'opt':
            return renderAbbrevOption(d.arg, state);
        case 'inp':
        case 'input':
            return `<code class="smcl-inp">${processSmcl(d.arg, state, currentFilePath)}</code>`;
        case 'err':
        case 'error':
            return `<span class="smcl-err">${processSmcl(d.arg, state, currentFilePath)}</span>`;
        case 'res':
        case 'result':
            return `<span class="smcl-res">${processSmcl(d.arg, state, currentFilePath)}</span>`;
        case 'txt':
        case 'text':
            return `<span class="smcl-txt">${processSmcl(d.arg, state, currentFilePath)}</span>`;
        case 'hi':
        case 'hilite':
            return `<span class="smcl-hi">${processSmcl(d.arg, state, currentFilePath)}</span>`;
        case 'sf':
            return `<span class="smcl-sf">${processSmcl(d.arg, state, currentFilePath)}</span>`;

        case 'cmdab': {
            const colonIdx = d.arg.indexOf(':');
            if (colonIdx >= 0) {
                const prefix = d.arg.substring(0, colonIdx);
                const suffix = d.arg.substring(colonIdx + 1);
                return `<code class="smcl-cmd"><span class="smcl-ul"><strong>${processSmcl(prefix, state, currentFilePath)}</strong></span>${processSmcl(suffix, state, currentFilePath)}</code>`;
            }
            return `<code class="smcl-cmd">${processSmcl(d.arg, state, currentFilePath)}</code>`;
        }

        case 'opth': {
            // `{opth name(topic)}` or `{opth ab:brev(topic:display)}` or `{opth vce:(regress##vcetype:vcetype)}`
            const m = d.arg.match(/^([^()]+)\(([^)]*)\)(.*)$/);
            if (m) {
                const optHead = m[1].trim();
                const innerSpec = m[2].trim();
                const trailing = m[3] || '';
                const colonIdx = optHead.indexOf(':');
                const optHtml = colonIdx >= 0
                    ? `<span class="smcl-ul">${escapeHtml(optHead.slice(0, colonIdx))}</span>${escapeHtml(optHead.slice(colonIdx + 1))}`
                    : escapeHtml(optHead);

                const [topicSpec, labelSpec] = splitAtTopLevelColon(innerSpec, true);
                const display = labelSpec !== null ? escapeHtml(stripOuterQuotes(labelSpec)) : escapeHtml(stripOuterQuotes(topicSpec));
                const linkHtml = renderHelpAnchorTag(topicSpec, `<em>${display}</em>`, '', 'help ');
                return `<code class="smcl-opt">${optHtml}(${linkHtml})${escapeHtml(trailing)}</code>`;
            }
            return renderAbbrevOption(d.arg, state);
        }

        case 'title':
            return `${closeOpenBlock(state)}<h2 class="smcl-title">${processSmcl(d.arg, state, currentFilePath)}</h2>`;

        case 'marker': {
            const id = stripOuterQuotes(d.arg).trim();
            return id ? `<a id="${escapeHtml(id)}"></a>` : '';
        }

        case 'pstd':
            return openParagraph('smcl-pstd', state);
        case 'psee':
            return openParagraph('smcl-psee', state);
        case 'phang':
        case 'phang2':
        case 'phang3':
            return openParagraph('smcl-phang', state);
        case 'pin':
        case 'pin2':
        case 'pin3':
        case 'pmore':
        case 'pmore2':
        case 'pmore3':
            return openParagraph('smcl-pin', state);

        case 'p': {
            if (d.arg && /^\d/.test(d.arg.trim())) {
                return openParagraph('smcl-pstd', state);
            }
            return openParagraph('', state);
        }
        case 'p_end':
            return closeOpenBlock(state);

        case 'hline': {
            const len = parseInt(d.arg.trim(), 10);
            if (!Number.isNaN(len) && len > 0 && len < 10) {
                return escapeHtml('\u2014'.repeat(len));
            }
            return `${closeOpenBlock(state)}<hr class="smcl-hline">`;
        }

        case 'break':
            return '<br>';

        case 'center':
            return `${closeOpenBlock(state)}<div class="smcl-center">${processSmcl(d.arg, state, currentFilePath)}</div>`;

        case 'col': {
            const n = Math.min(Math.max(parseInt(d.arg, 10) || 0, 0), 120);
            if (n > 0) {
                return `<span style="display:inline-block; min-width:${n * 0.5}em;"></span>`;
            }
            return '';
        }

        case 'space': {
            const n = Math.min(Math.max(parseInt(d.arg, 10) || 1, 0), 120);
            return '&nbsp;'.repeat(n);
        }

        case 'vspace': {
            const n = Math.min(Math.max(parseInt(d.arg, 10) || 1, 0), 20);
            return '<br>'.repeat(n);
        }

        case 'tab':
            return '&emsp;&emsp;';

        case 'synoptset': {
            const prefix = closeOpenBlock(state);
            state.inSynoptset = true;
            state.synoptsetWidth = parseInt(d.arg, 10) || 20;
            return `${prefix}<table class="smcl-synopt-table">`;
        }

        case 'synopthdr': {
            const prefix = closeOpenBlock(state);
            const label = d.arg.trim() || 'Options';
            return `${prefix}<tr class="smcl-synopt-hdr"><th class="smcl-synopt-col1">${processSmcl(label, state, currentFilePath)}</th><th class="smcl-synopt-col2">Description</th></tr>`;
        }

        case 'synoptline':
            return `${closeOpenBlock(state)}<tr class="smcl-synopt-line"><td colspan="2"><hr></td></tr>`;

        case 'syntab':
            return `${closeOpenBlock(state)}<tr class="smcl-syntab"><td colspan="2"><strong>${processSmcl(d.arg, state, currentFilePath)}</strong></td></tr>`;

        case 'synopt':
        case 'p2coldent': {
            const prefix = closeOpenBlock(state);
            if (state.inSynoptset) {
                state.openBlock = 'synopt';
                return `${prefix}<tr class="smcl-synopt-row"><td class="smcl-synopt-col1">${processSmcl(d.arg, state, currentFilePath)}</td><td class="smcl-synopt-col2">`;
            }
            state.openBlock = 'p2col';
            return `${prefix}<div class="smcl-p2col"><div class="smcl-p2col-left">${processSmcl(d.arg, state, currentFilePath)}</div><div class="smcl-p2col-right">`;
        }

        case 'p2colset':
            state.inP2col = true;
            return closeOpenBlock(state);
        case 'p2colreset':
            state.inP2col = false;
            return closeOpenBlock(state);
        case 'p2col': {
            const prefix = closeOpenBlock(state);
            state.openBlock = 'p2col';
            return `${prefix}<div class="smcl-p2col"><div class="smcl-p2col-left">${processSmcl(d.arg, state, currentFilePath)}</div><div class="smcl-p2col-right">`;
        }
        case 'p2line':
            return `${closeOpenBlock(state)}<hr class="smcl-hline">`;

        case 'help':
        case 'helpb': {
            // `{help topic}`, `{help topic:display}`, `{help "topic with spaces":display}`
            let topicRaw: string;
            let displayRaw: string;
            if (d.hasColonAfterName) {
                const [left, right] = splitAtTopLevelColon(d.arg);
                topicRaw = left;
                displayRaw = right ?? left;
            } else {
                const [left, right] = splitAtTopLevelColon(d.arg);
                if (right !== null) {
                    topicRaw = left;
                    displayRaw = right;
                } else {
                    topicRaw = d.arg;
                    displayRaw = d.arg;
                }
            }
            const cleanDisplay = stripOuterQuotes(displayRaw.trim()) || stripOuterQuotes(topicRaw.trim());
            const innerHtml = processSmcl(cleanDisplay, state, currentFilePath);
            const wrapped = name === 'helpb' ? `<strong>${innerHtml}</strong>` : innerHtml;
            const extraCls = name === 'helpb' ? 'smcl-link-bold' : '';
            return renderHelpAnchorTag(topicRaw, wrapped, extraCls, 'help ');
        }

        case 'manhelp': {
            // `{manhelp topic MANUAL}` or `{manhelp topic MANUAL:display}`
            const [left, right] = splitAtTopLevelColon(d.arg);
            const tokens = splitQuotedTokens(left);
            const topic = tokens[0] || left.trim();
            const manual = tokens[1] || '';
            const displayHtml = right !== null
                ? processSmcl(stripOuterQuotes(right), state, currentFilePath)
                : escapeHtml(manual ? `[${manual}] ${topic}` : topic);
            return renderHelpAnchorTag(topic, displayHtml, 'smcl-link-manual', 'help ');
        }

        case 'mansection': {
            // `{mansection MANUAL section}` or `{mansection MANUAL section:display}`
            const [left, right] = splitAtTopLevelColon(d.arg);
            const tokens = splitQuotedTokens(left);
            const manual = tokens[0] || '';
            const section = tokens.slice(1).join(' ');
            const displayHtml = right !== null
                ? processSmcl(stripOuterQuotes(right), state, currentFilePath)
                : escapeHtml(manual ? `[${manual}] ${section}` : left.trim());
            return `<span class="smcl-link smcl-link-manual" title="${escapeHtml(`PDF manual: [${manual}] ${section}`.trim())}">${displayHtml}</span>`;
        }

        case 'manlink':
        case 'manlinki': {
            const [left, right] = splitAtTopLevelColon(d.arg);
            const tokens = splitQuotedTokens(left);
            const display = right !== null
                ? stripOuterQuotes(right)
                : tokens.length >= 2 ? `[${tokens[0]}] ${tokens.slice(1).join(' ')}` : left.trim();
            const inner = escapeHtml(display);
            return `<span class="smcl-link smcl-link-manual">${name === 'manlinki' ? `<em>${inner}</em>` : inner}</span>`;
        }

        case 'vieweralsosee': {
            const tokens = splitQuotedTokens(d.arg);
            const text = (tokens[0] || '').trim();
            const topic = (tokens[1] || '').trim();
            if (text && topic && topic !== '--') {
                state.alsoSeeEntries.push({ text, topic });
            }
            return '';
        }

        case 'viewerjumpto': {
            const tokens = splitQuotedTokens(d.arg);
            const text = (tokens[0] || '').trim();
            let anchor = (tokens[1] || '').trim();
            const hashIdx = anchor.indexOf('##');
            if (hashIdx >= 0) {
                anchor = anchor.substring(hashIdx + 2);
            }
            if (text && anchor) {
                state.tocEntries.push({ label: text, anchor });
            }
            return '';
        }

        case 'viewerdialog':
        case 'findalias':
        case 'smcl':
        case 'com':
        case 'asis':
        case 'smcl_on':
        case 's6hlp':
        case '...':
        case '*':
            return '';

        case 'c': {
            const ch = (d.arg || '').trim();
            switch (ch) {
                case '|': return '|';
                case '-': return '-';
                case '+': return '+';
                case "'": return '&#39;';
                case '`': return '`';
                case '{': return '{';
                case '}': return '}';
                case '(': return '(';
                case ')': return ')';
                case 'S|': return '$';
                case '-(': return '{';
                case ')-': return '}';
                case 'TLC': return '\u250C';
                case 'TRC': return '\u2510';
                case 'BLC': return '\u2514';
                case 'BRC': return '\u2518';
                case 'LT': return '\u251C';
                case 'RT': return '\u2524';
                case 'TT': return '\u252C';
                case 'BT': return '\u2534';
                case 'CT':
                case 'CRS': return '\u253C';
                default:
                    return safeCharFromCode(ch);
            }
        }

        case 'char':
            return safeCharFromCode(d.arg);

        case 'stata': {
            const [cmdPart, labelPart] = splitAtTopLevelColon(d.arg);
            const display = labelPart !== null ? stripOuterQuotes(labelPart) : stripOuterQuotes(cmdPart);
            return `<code class="smcl-cmd smcl-stata-link">${processSmcl(display, state, currentFilePath)}</code>`;
        }

        case 'browse': {
            let urlRaw: string;
            let displayRaw: string;
            const [left, right] = splitAtTopLevelColon(d.arg);
            if (right !== null) {
                urlRaw = stripOuterQuotes(left);
                displayRaw = stripOuterQuotes(right);
            } else {
                const tokens = splitQuotedTokens(d.arg);
                urlRaw = tokens[0] || '';
                displayRaw = tokens.length > 1 ? tokens.slice(1).join(' ') : urlRaw;
            }

            const displayHtml = right !== null
                ? processSmcl(displayRaw || urlRaw, state, currentFilePath)
                : escapeHtml(displayRaw || urlRaw);

            const resolved = resolveBrowseTarget(urlRaw, currentFilePath);
            if (resolved.kind === 'external') {
                return `<a class="smcl-link" href="${escapeHtml(resolved.url)}" data-browse-url="${escapeHtml(resolved.url)}" title="${escapeHtml(resolved.url)}">${displayHtml}</a>`;
            }
            if (resolved.kind === 'localFile') {
                return `<a class="smcl-link" href="#" data-local-file="${escapeHtml(resolved.filePath)}" title="${escapeHtml(resolved.filePath)}">${displayHtml}</a>`;
            }
            return `<span>${displayHtml}</span>`;
        }

        case 'bind':
            return processSmcl(d.arg, state, currentFilePath);

        case 'dlgtab':
            return `${closeOpenBlock(state)}<h3 class="smcl-dlgtab">${processSmcl(d.arg, state, currentFilePath)}</h3>`;

        case 'var':
        case 'varname':
        case 'varlist':
        case 'newvar':
        case 'newvarlist':
        case 'depvar':
        case 'depvars':
        case 'indepvars':
            return `<em class="smcl-var">${processSmcl(d.arg || name, state, currentFilePath)}</em>`;

        case 'ifin':
            return '<span class="smcl-txt"> [<code class="smcl-cmd">if</code>] [<code class="smcl-cmd">in</code>]</span>';

        case 'weight':
            return '<span class="smcl-txt"> [<em>weight</em>]</span>';

        case 'dtype':
            return `<span class="smcl-txt">${processSmcl(d.arg || 'type', state, currentFilePath)}</span>`;

        case 'n2col':
        case 'ncol':
            return openParagraph('smcl-pstd', state);

        case 'ralign':
        case 'right': {
            const [, rightText] = d.hasColonAfterName ? ['', d.arg] : splitAtTopLevelColon(d.arg);
            const content = rightText !== null ? rightText : d.arg;
            return `<span style="float:right">${processSmcl(content, state, currentFilePath)}</span>`;
        }

        case 'dup': {
            const [countStr, charStr] = splitAtTopLevelColon(d.arg);
            const n = Math.min(Math.max(parseInt(countStr, 10) || 0, 0), 200);
            const ch = charStr !== null && charStr.length > 0 ? charStr : '-';
            return escapeHtml(ch.repeat(n));
        }

        case 'ccl':
        case 'cclopt':
            return `<code class="smcl-cmd">${processSmcl(d.arg, state, currentFilePath)}</code>`;

        default: {
            if (d.hasColonAfterName && d.arg) {
                return processSmcl(d.arg, state, currentFilePath);
            }
            return '';
        }
    }
}

function expandIncludes(
    text: string,
    resolver?: (includeTopic: string) => string | undefined,
    depth = 0,
): string {
    return text.replace(/^INCLUDE\s+help\s+(\S+)\s*$/gm, (_match, rawTopic: string) => {
        const clean = rawTopic.trim();
        if (resolver && depth < 3) {
            const parsed = parseHelpTarget(clean);
            if (parsed && parsed.topic) {
                const included = resolver(parsed.topic);
                if (typeof included === 'string') {
                    const normalized = included
                        .replace(/^\uFEFF/, '')
                        .replace(/\r\n?/g, '\n')
                        .replace(/\{\.\.\.\}[ \t]*\n/g, '');
                    return expandIncludes(normalized, resolver, depth + 1);
                }
            }
        }
        return `{* include_placeholder:${clean}}`;
    });
}

/**
 * Split SMCL document into logical lines, keeping multi-line `{...}` directives intact
 * when braces span across a newline.
 */
function splitSmclLogicalLines(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    let braceDepth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            braceDepth++;
        } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
        } else if (ch === '\n' && braceDepth === 0) {
            lines.push(text.slice(start, i));
            start = i + 1;
        }
    }
    if (start <= text.length) {
        lines.push(text.slice(start));
    }
    return lines;
}

export function smclToHtml(smclText: string, fileName: string, options: SmclRenderOptions = {}): string {
    const state: ParseState = {
        inSynoptset: false,
        synoptsetWidth: 20,
        inP2col: false,
        openBlock: null,
        tocEntries: [],
        alsoSeeEntries: [],
        ulOn: false,
    };

    // Normalize BOM and Windows CRLF line endings, expand INCLUDE directives, then strip `{...}` continuations
    let processed = smclText
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n');

    processed = expandIncludes(processed, options.includeResolver, 0)
        .replace(/\{\.\.\.\}[ \t]*\n/g, '');

    const lines = splitSmclLogicalLines(processed);
    const bodyParts: string[] = [];
    let inSynoptTable = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '{smcl}' || trimmed === '{* *! ...}' || trimmed === '') {
            if (trimmed === '' && !inSynoptTable && state.openBlock === null) {
                bodyParts.push('<div class="smcl-blank"></div>');
            }
            continue;
        }

        const includePlaceholder = trimmed.match(/^\{\*\s*include_placeholder:(.+)\}$/);
        if (includePlaceholder) {
            bodyParts.push(`${closeOpenBlock(state)}<div class="smcl-include">[include: ${escapeHtml(includePlaceholder[1])}]</div>`);
            continue;
        }

        // Close an already-open synopt table before opening a new one or resetting
        if (trimmed === '{synoptset}' || (inSynoptTable && (trimmed.startsWith('{synoptset') || trimmed === '{p2colreset}'))) {
            bodyParts.push(`${closeOpenBlock(state)}</table>`);
            inSynoptTable = false;
            state.inSynoptset = false;
            if (trimmed === '{synoptset}') {
                continue;
            }
        }

        if (trimmed.startsWith('{synoptset')) {
            inSynoptTable = true;
        }

        const html = processSmcl(line, state, options.currentFilePath);
        if (html.trim()) {
            bodyParts.push(html);
        }
    }

    const trailingClose = closeOpenBlock(state);
    if (trailingClose) {
        bodyParts.push(trailingClose);
    }

    if (inSynoptTable) {
        bodyParts.push('</table>');
    }

    let tocHtml = '';
    if (state.tocEntries.length > 0) {
        tocHtml = '<nav class="smcl-toc"><ul>';
        for (const entry of state.tocEntries) {
            tocHtml += `<li><a href="#${escapeHtml(entry.anchor)}" data-anchor="${escapeHtml(entry.anchor)}">${escapeHtml(entry.label)}</a></li>`;
        }
        tocHtml += '</ul></nav>';
    }

    let alsoSeeHtml = '';
    if (state.alsoSeeEntries.length > 0) {
        alsoSeeHtml = '<div class="smcl-alsosee"><h3>Also see</h3><ul>';
        for (const entry of state.alsoSeeEntries) {
            const linkHtml = renderHelpAnchorTag(entry.topic, escapeHtml(entry.text), '', '');
            alsoSeeHtml += `<li>${linkHtml}</li>`;
        }
        alsoSeeHtml += '</ul></div>';
    }

    const rawBase = crossPlatformBasename(fileName);
    const dotIdx = rawBase.lastIndexOf('.');
    const baseName = dotIdx > 0 ? rawBase.slice(0, dotIdx) : rawBase;

    const cspStyleSrc = options.cspSource ? `${options.cspSource} 'unsafe-inline'` : `'unsafe-inline'`;
    const cspScriptSrc = options.nonce ? ` script-src 'nonce-${escapeHtml(options.nonce)}';` : '';
    const csp = `default-src 'none'; style-src ${cspStyleSrc};${cspScriptSrc}`;

    const initialAnchorAttr = options.initialAnchor ? ` data-initial-anchor="${escapeHtml(options.initialAnchor)}"` : '';

    const scriptBlock = options.nonce
        ? `<script nonce="${escapeHtml(options.nonce)}">
(function() {
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

    function scrollToAnchor(anchor) {
        if (!anchor) return;
        const target = document.getElementById(anchor);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    document.addEventListener('click', function(e) {
        const link = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!link) return;

        const anchor = link.getAttribute('data-anchor');
        if (anchor) {
            e.preventDefault();
            scrollToAnchor(anchor);
            return;
        }

        const helpTarget = link.getAttribute('data-help');
        if (helpTarget && vscode) {
            e.preventDefault();
            vscode.postMessage({ type: 'openHelp', target: helpTarget });
            return;
        }

        const browseUrl = link.getAttribute('data-browse-url');
        if (browseUrl && vscode) {
            e.preventDefault();
            vscode.postMessage({ type: 'openExternal', url: browseUrl });
            return;
        }

        const localFile = link.getAttribute('data-local-file');
        if (localFile && vscode) {
            e.preventDefault();
            vscode.postMessage({ type: 'openLocalFile', filePath: localFile });
            return;
        }
    });

    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg && typeof msg === 'object' && msg.type === 'scrollToAnchor' && typeof msg.anchor === 'string') {
            scrollToAnchor(msg.anchor);
        }
    });

    const initial = document.body.getAttribute('data-initial-anchor');
    if (initial) {
        scrollToAnchor(initial);
    }
})();
</script>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${getStyles()}
</style>
</head>
<body${initialAnchorAttr}>
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
${scriptBlock}
</body>
</html>`;
}

function getStyles(): string {
    return `
:root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --fg-dim: var(--vscode-descriptionForeground, #888888);
    --border: var(--vscode-contrastBorder, var(--vscode-panel-border, #2d2d2d));
    --link: var(--vscode-textLink-foreground, #4daafc);
    --link-hover: var(--vscode-textLink-activeForeground, #74c0fc);
    --code-bg: var(--vscode-textCodeBlock-background, #2a2a2a);
    --code-fg: var(--vscode-textPreformat-foreground, #d4d4d4);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #ffffff);
    --heading-fg: var(--vscode-editor-foreground, #cccccc);
    --table-border: var(--vscode-contrastBorder, var(--vscode-panel-border, #333333));
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

.smcl-body {
    line-height: 1.7;
}
.smcl-body > p, .smcl-body > div {
    margin-bottom: 2px;
}
.smcl-blank {
    height: 6px;
}

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

code.smcl-cmd {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
    font-size: 13px;
    color: var(--link);
    background: transparent;
    padding: 0;
}
code.smcl-opt {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
    font-size: 13px;
    color: var(--code-fg);
}
code.smcl-inp {
    font-family: var(--vscode-editor-font-family, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
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
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 3px;
}

hr.smcl-hline {
    border: none;
    border-top: 1px solid var(--border);
    margin: 12px 0;
}

.smcl-center {
    text-align: center;
    margin: 8px 0;
}

a.smcl-link, span.smcl-link {
    color: var(--link);
    text-decoration: none;
}
a.smcl-link {
    cursor: pointer;
}
a.smcl-link:hover {
    color: var(--link-hover);
    text-decoration: underline;
}
.smcl-link-bold {
    font-weight: 700;
}
.smcl-link-manual {
    font-style: italic;
}

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
    border-bottom: 1px solid var(--table-border);
}
td.smcl-synopt-col1 {
    width: 40%;
    min-width: 180px;
    white-space: nowrap;
}

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

.smcl-include {
    color: var(--fg-dim);
    font-size: 12px;
    font-style: italic;
    padding: 4px 0;
}

@media (max-width: 600px) {
    .smcl-container { padding: 16px; }
    .smcl-p2col { flex-direction: column; gap: 4px; }
    td.smcl-synopt-col1, th.smcl-synopt-col1 { min-width: 120px; width: 35%; }
}
`;
}
