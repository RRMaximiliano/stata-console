import { toStataPath } from './backend';
import { scanLine, startsEndBlock, type ScanState } from './stataLexer';

/**
 * Pure generators for the Stata code the extension runs on the user's behalf:
 * do-file rewriting (browse and graph capture), the Data Viewer export helper,
 * and the post-run state export. No `vscode` dependency.
 */

/** Escape `$` and backticks so Stata does not expand them inside a path. */
export function stataPathText(fsPath: string): string {
    return toStataPath(fsPath).replace(/[`$]/g, '\\$&');
}

/** A path as a Stata compound-quoted string literal, safe on every platform. */
export function stataQuote(fsPath: string): string {
    return '`"' + stataPathText(fsPath) + '"\'';
}

/** Collapse tabs and line breaks so a value fits on one TSV row. */
export function sanitizeField(value: string): string {
    return value.replace(/[\t\r\n]+/g, ' ');
}

/** `run` would take a comma in the browse arguments as its own option list. */
const COMMA_TOKEN = '__VSC_COMMA__';

export const BROWSE_RE = /^(br|bro|brow|brows|browse|ed|edi|edit)\b(.*)$/i;

const GRAPH_PREFIX_RE = /^(?:(?:quietly|qui|capture|cap|noisily|noi|n)\s+|(?:by|bys|bysort)\s+[^:]*:\s*)*/;
const GRAPH_RE = /^(?:scatter|histogram|hist|kdensity|twoway|tw|two|line|connected|area|tsline|xtline|graph\s+(?:bar|box|hbox|pie|dot|hbar|combine|matrix|twoway)|gr(?:a|ap)?\s+(?:bar|box|hbox|pie|dot|hbar|combine|matrix|twoway)|coefplot|binscatter|marginsplot|sts\s+graph|stcurve|qnorm|pnorm|qqplot|gladder|lowess|lpoly|avplot|avplots|rvfplot|cprplot|acprplot|lvr2plot|dotplot|spikeplot|cdfplot|heatplot|ac|pac)\b/;

/** Does this (comment-free) command draw a graph in the Graph window? */
export function isGraphCommand(command: string): boolean {
    const s = command.replace(/^\.\s*/, '').trim().toLowerCase().replace(GRAPH_PREFIX_RE, '');
    if (!s) { return false; }
    return GRAPH_RE.test(s);
}

/** The quoted argument string for the Data Viewer helper. */
export function browseArgs(args: string): string {
    return '`"' + args.trim().replace(/,/g, COMMA_TOKEN) + '"\'';
}

export interface RewriteOptions {
    /** Session temp directory (filesystem form). */
    dir: string;
    /** Unique per run; keeps capture file names distinct. */
    runId: number;
    browseLimit: number;
    /** Do-file that exports the Data Viewer CSV (see `buildBrowseHelper`). */
    browseHelper: string;
    graphWidth?: number;
}

export interface RewriteResult {
    code: string;
    graphCount: number;
    /** Base name (no extension) of the browse export, when the code browses. */
    browseBase?: string;
}

/**
 * Prepare user code for a temp do-file: `browse`/`edit` become a Data Viewer
 * export and an `graph export` follows each graph command so every plot is
 * captured. Code inside `#delimit ;` regions and `mata`/`program` blocks is
 * left alone. Line endings are normalized to `\n`.
 */
export function rewriteCode(code: string, o: RewriteOptions): RewriteResult {
    const lines = code.split(/\r\n|\r|\n/);
    const out: string[] = [];
    const state: ScanState = { blockDepth: 0 };
    const width = o.graphWidth ?? 800;
    let continued = false;
    let inGraph = false;
    let graphSkipped = false;
    let delimitSemi = false;
    let untilEnd = false;
    let graphCount = 0;
    let browseBase: string | undefined;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const insideComment = state.blockDepth > 0;
        const atStart = !continued && !insideComment;
        const scan = scanLine(line, state, !continued);
        const command = scan.code.trim();
        continued = scan.continued;

        if (untilEnd) {
            out.push(line);
            if (command.toLowerCase() === 'end') { untilEnd = false; }
            continue;
        }
        if (atStart && startsEndBlock(command)) {
            untilEnd = true;
            out.push(line);
            continue;
        }
        if (atStart) {
            const delimit = command.match(/^#delimit\s+(;|cr)/i);
            if (delimit) { delimitSemi = delimit[1] === ';'; }
        }
        if (delimitSemi || insideComment) {
            out.push(line);
            continue;
        }

        if (atStart && command) {
            const browse = line.trim().match(BROWSE_RE);
            if (browse && !/^\s*[=(]/.test(browse[2])) {
                browseBase = `_browse_${o.runId}`;
                const indent = line.match(/^\s*/)?.[0] ?? '';
                // Join `///` continuation lines so the arguments are one string.
                let args = line.slice(0, scan.end).trim().slice(browse[1].length);
                let more = scan.continued;
                while (more && li + 1 < lines.length) {
                    const next = lines[++li];
                    const nextScan = scanLine(next, state, false);
                    args += ' ' + next.slice(0, nextScan.end).trim();
                    more = nextScan.continued;
                }
                args = args.trim();
                out.push(`${indent}quietly run ${stataQuote(o.browseHelper)} ${o.browseLimit} ${browseBase} ${browseArgs(args)}`);
                continued = false;
                continue;
            }
        }

        out.push(line);

        if (!inGraph && atStart && isGraphCommand(command)) {
            inGraph = true;
            graphSkipped = false;
        }
        if (inGraph) {
            // A `nodraw` graph is not displayed, so exporting would grab a stale one.
            if (/\bnodraw\b/.test(command)) { graphSkipped = true; }
            if (!scan.continued && state.blockDepth === 0) {
                inGraph = false;
                if (!graphSkipped) {
                    graphCount++;
                    const file = `${o.dir}/_cap_${o.runId}_${graphCount}.png`;
                    out.push(`capture quietly graph export ${stataQuote(file)}, as(png) width(${width}) replace`);
                }
            }
        }
    }

    return { code: out.join('\n') + '\n', graphCount, browseBase };
}

/**
 * Do-file behind the Data Viewer. Called as
 * `quietly run "<helper>" <rowLimit> <baseName> \`"[varlist] [if] [in] [, nolabel]"'`
 * (the browse arguments travel as one quoted string with commas replaced by a
 * token, because `run` would otherwise take a comma as the start of its own
 * options; use `browseArgs` to build it).
 * Exports at most `rowLimit` matching observations to `<dir>/<baseName>.csv`
 * and the true number of matching observations to `<baseName>.count`, without
 * changing the data, the sort order, or r().
 */
export function buildBrowseHelper(dir: string): string {
    const out = (ext: string) => '`"' + stataPathText(dir) + "/`_vsc_base'" + ext + '"\'';
    return [
        `gettoken _vsc_limit 0 : 0`,
        `gettoken _vsc_base 0 : 0`,
        `gettoken _vsc_args 0 : 0`,
        `local 0 = subinstr(\`"\`_vsc_args'"', "${COMMA_TOKEN}", ",", .)`,
        `capture file close _vsc_bf`,
        `if _N == 0 | c(k) == 0 {`,
        `    capture erase ${out('.csv')}`,
        `    file open _vsc_bf using ${out('.count')}, write replace`,
        `    file write _vsc_bf "0" _n`,
        `    file close _vsc_bf`,
        `    exit`,
        `}`,
        `_return hold _vsc_bh`,
        `capture noisily {`,
        `    syntax [varlist] [if] [in] [, noLabel fast]`,
        `    local _a = 1`,
        `    local _b = _N`,
        `    if \`"\`in'"' != "" {`,
        `        local _r = strtrim(substr(\`"\`in'"', 3, .))`,
        `        gettoken _x _y : _r, parse("/")`,
        `        local _y = strtrim(substr(\`"\`_y'"', 2, .))`,
        `        if "\`_y'" == "" {`,
        `            local _y "\`_x'"`,
        `        }`,
        `        local _a = cond("\`_x'" == "f", 1, cond("\`_x'" == "l", _N, cond(real("\`_x'") < 0, _N + real("\`_x'") + 1, real("\`_x'"))))`,
        `        local _b = cond("\`_y'" == "f", 1, cond("\`_y'" == "l", _N, cond(real("\`_y'") < 0, _N + real("\`_y'") + 1, real("\`_y'"))))`,
        `        local _a = max(\`_a', 1)`,
        `        local _b = min(\`_b', _N)`,
        `    }`,
        `    if \`"\`if'"' == "" {`,
        `        local _m = max(\`_b' - \`_a' + 1, 0)`,
        `    }`,
        `    else {`,
        `        quietly count \`if' in \`_a'/\`_b'`,
        `        local _m = r(N)`,
        `    }`,
        `    local _k = \`_b'`,
        `    if \`_m' > \`_vsc_limit' {`,
        `        if \`"\`if'"' == "" {`,
        `            local _k = \`_a' + \`_vsc_limit' - 1`,
        `        }`,
        `        else {`,
        `            local _lo = \`_a'`,
        `            local _hi = \`_b'`,
        `            while \`_lo' < \`_hi' {`,
        `                local _mid = floor((\`_lo' + \`_hi') / 2)`,
        `                quietly count \`if' in \`_a'/\`_mid'`,
        `                if r(N) >= \`_vsc_limit' {`,
        `                    local _hi = \`_mid'`,
        `                }`,
        `                else {`,
        `                    local _lo = \`_mid' + 1`,
        `                }`,
        `            }`,
        `            local _k = \`_lo'`,
        `        }`,
        `    }`,
        `    capture erase ${out('.csv')}`,
        `    if \`_m' > 0 {`,
        `        quietly export delimited \`varlist' \`if' in \`_a'/\`_k' using ${out('.csv')}, \`label' replace`,
        `    }`,
        `    file open _vsc_bf using ${out('.count')}, write replace`,
        `    file write _vsc_bf "\`_m'" _n`,
        `    file close _vsc_bf`,
        `}`,
        `local _vsc_rc = _rc`,
        `capture file close _vsc_bf`,
        `_return restore _vsc_bh`,
        `if \`_vsc_rc' != 0 {`,
        `    exit \`_vsc_rc'`,
        `}`,
    ].join('\n') + '\n';
}

function oneLine(expr: string): string {
    return `subinstr(subinstr(subinstr(${expr}, char(9), " ", .), char(10), " ", .), char(13), " ", .)`;
}

export interface PostPaths {
    meta: string;
    vars: string;
    results: string;
    graph: string;
    graphSig: string;
}

/**
 * Do-file run (silently) after every execution to export dataset metadata,
 * the variable list, stored e()/r() results, and a fallback copy of the
 * current graph. It leaves the user's state untouched: data, sort order,
 * `_rc`, r(), e(), and c(filename).
 */
export function buildPostDoFile(p: PostPaths, graphWidth = 800): string {
    // Every value goes through `macval` inside a compound quote so labels with
    // quotes, backticks, `$`, tabs, or line breaks cannot break `file write`.
    const field = (name: string) => '(`"`macval(' + name + ")'\"')";
    const lines = [
        `local _vsc_rc = _rc`,
        `foreach _vsc_h in _vsc_mh _vsc_fh _vsc_rh _vsc_gh {`,
        `    capture file close \`_vsc_h'`,
        `}`,

        // Dataset metadata
        `capture {`,
        `    local _vsc_dl : data label`,
        `    local _vsc_dl = ${oneLine('`"`macval(_vsc_dl)\'"\'')}`,
        `    local _vsc_fn = ${oneLine('c(filename)')}`,
        `    file open _vsc_mh using ${stataQuote(p.meta)}, write replace`,
        `    file write _vsc_mh (_N) _tab (c(k)) _tab ${field('_vsc_fn')} _tab ${field('_vsc_dl')} _n`,
        `    file close _vsc_mh`,
        `}`,

        // Variable list
        `capture {`,
        `    file open _vsc_fh using ${stataQuote(p.vars)}, write replace`,
        `    file write _vsc_fh "name" _tab "type" _tab "format" _tab "label" _n`,
        `    if c(k) > 0 {`,
        `        foreach _vsc_v of varlist _all {`,
        `            local _vsc_t : type \`_vsc_v'`,
        `            local _vsc_f : format \`_vsc_v'`,
        `            local _vsc_l : variable label \`_vsc_v'`,
        `            local _vsc_l = ${oneLine('`"`macval(_vsc_l)\'"\'')}`,
        `            file write _vsc_fh "\`_vsc_v'" _tab "\`_vsc_t'" _tab "\`_vsc_f'" _tab ${field('_vsc_l')} _n`,
        `        }`,
        `    }`,
        `    file close _vsc_fh`,
        `}`,

        // Stored results: e() scalars/macros, r() scalars/macros
        `capture {`,
        `    file open _vsc_rh using ${stataQuote(p.results)}, write replace`,
        `    file write _vsc_rh "type" _tab "name" _tab "value" _n`,
        `}`,
        `foreach _vsc_c in e r {`,
        `    local _vsc_list : \`_vsc_c'(scalars)`,
        `    foreach _vsc_s of local _vsc_list {`,
        `        capture file write _vsc_rh "\`_vsc_c'" _tab "\`_vsc_s'" _tab (strtrim(string(\`_vsc_c'(\`_vsc_s'), "%18.10g"))) _n`,
        `    }`,
        `    local _vsc_list : \`_vsc_c'(macros)`,
        `    foreach _vsc_s of local _vsc_list {`,
        `        capture {`,
        `            local _vsc_val = substr(\`_vsc_c'(\`_vsc_s'), 1, 1000)`,
        `            local _vsc_val = ${oneLine('`"`macval(_vsc_val)\'"\'')}`,
        `            file write _vsc_rh "\`_vsc_c'm" _tab "\`_vsc_s'" _tab ${field('_vsc_val')} _n`,
        `        }`,
        `    }`,
        `}`,
        `capture file close _vsc_rh`,

        // Fallback graph export (graphs from nested do-files and programs).
        // Only when the current graph differs from the one exported last time.
        `_return hold _vsc_ph`,
        `capture {`,
        `    quietly graph describe`,
        `    local _vsc_sig = r(command_date) + "|" + r(command_time) + "|" + string(strlen(r(command)))`,
        `    local _vsc_prev ""`,
        `    capture file open _vsc_gh using ${stataQuote(p.graphSig)}, read`,
        `    if _rc == 0 {`,
        `        file read _vsc_gh _vsc_prev`,
        `        file close _vsc_gh`,
        `    }`,
        `    if \`"\`_vsc_prev'"' != \`"\`_vsc_sig'"' {`,
        `        quietly graph export ${stataQuote(p.graph)}, as(png) width(${graphWidth}) replace`,
        `        file open _vsc_gh using ${stataQuote(p.graphSig)}, write replace`,
        `        file write _vsc_gh \`"\`_vsc_sig'"' _n`,
        `        file close _vsc_gh`,
        `    }`,
        `}`,
        `capture file close _vsc_gh`,
        `_return restore _vsc_ph`,

        // Put _rc back
        `capture error \`_vsc_rc'`,
    ];
    return lines.join('\n') + '\n';
}
