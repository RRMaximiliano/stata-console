/**
 * ANSI syntax highlighting for Stata code shown in the console (echoed
 * commands and the line being typed), in the spirit of radian for R.
 * Single-line and forgiving: unterminated strings or comments simply run to
 * the end of the line. No `vscode` dependency.
 */
export interface HighlightPalette {
    command: string;
    keyword: string;
    string: string;
    macro: string;
    number: string;
    comment: string;
    func: string;
    reset: string;
}

const fg = (hex: string) => {
    const h = hex.replace('#', '');
    return `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`;
};

/** VS Code Dark+ editor colors. */
export const DARK_HIGHLIGHT: HighlightPalette = {
    command: fg('#569CD6'),
    keyword: fg('#C586C0'),
    string: fg('#CE9178'),
    macro: fg('#4EC9B0'),
    number: fg('#B5CEA8'),
    comment: fg('#6A9955'),
    func: fg('#DCDCAA'),
    reset: '\x1b[0m',
};

/** VS Code Light+ editor colors. */
export const LIGHT_HIGHLIGHT: HighlightPalette = {
    command: fg('#0000FF'),
    keyword: fg('#AF00DB'),
    string: fg('#A31515'),
    macro: fg('#267F99'),
    number: fg('#098658'),
    comment: fg('#008000'),
    func: fg('#795E26'),
    reset: '\x1b[0m',
};

/** Words that are colored as keywords wherever they appear. */
const KEYWORDS = new Set([
    'if', 'in', 'using', 'of', 'else', 'local', 'global', 'tempvar', 'tempname', 'tempfile',
    'varlist', 'newlist', 'numlist', 'to', 'by', 'bysort', 'bys', 'quietly', 'qui', 'noisily', 'noi',
    'capture', 'cap', 'foreach', 'forvalues', 'forval', 'while', 'continue', 'break', 'program', 'end',
    'syntax', 'args', 'version', 'preserve', 'restore', 'exit', 'return', 'ereturn', 'sreturn',
]);

/** Prefixes after which the next word is still a command. */
const PREFIX_RE = /^(?:qui(?:e(?:t(?:l(?:y)?)?)?)?|cap(?:t(?:u(?:r(?:e)?)?)?)?|n(?:o(?:i(?:s(?:i(?:l(?:y)?)?)?)?)?)?|bys(?:o(?:r(?:t)?)?)?|by|xi|svy|stepwise|rolling|statsby|bootstrap|jackknife|permute|simulate|nestreg)$/i;

/**
 * Highlight one line of Stata code. `statementStart` is false for wrapped or
 * continued lines, where the first word is not a command.
 */
export function highlightStata(code: string, p: HighlightPalette, statementStart = true): string {
    let out = '';
    let i = 0;
    let expectCommand = statementStart;
    const n = code.length;
    const paint = (color: string, text: string) => { out += color + text + p.reset; };

    // `*` comment: the whole line, but only at the start of a statement
    if (statementStart && /^\s*\*/.test(code)) {
        const lead = code.match(/^\s*/)?.[0] ?? '';
        return lead + p.comment + code.slice(lead.length) + p.reset;
    }

    while (i < n) {
        const ch = code[i];
        const rest = code.slice(i);

        // Comments: `//` (and `///`) after whitespace or at the start, `/* ... */`
        if (rest.startsWith('//') && (i === 0 || /\s/.test(code[i - 1]))) {
            paint(p.comment, rest);
            break;
        }
        if (rest.startsWith('/*')) {
            const end = code.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            paint(p.comment, code.slice(i, stop));
            i = stop;
            continue;
        }

        // Compound string `"..."' and plain string "..."
        if (rest.startsWith('`"')) {
            const end = code.indexOf('"\'', i + 2);
            const stop = end === -1 ? n : end + 2;
            out += highlightString(code.slice(i, stop), p);
            i = stop;
            expectCommand = false;
            continue;
        }
        if (ch === '"') {
            const end = code.indexOf('"', i + 1);
            const stop = end === -1 ? n : end + 1;
            out += highlightString(code.slice(i, stop), p);
            i = stop;
            expectCommand = false;
            continue;
        }

        // Macros: `local' (nested allowed), $global, ${global}
        if (ch === '`') {
            const stop = macroEnd(code, i);
            paint(p.macro, code.slice(i, stop));
            i = stop;
            expectCommand = false;
            continue;
        }
        const global = rest.match(/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/);
        if (global) {
            paint(p.macro, global[0]);
            i += global[0].length;
            expectCommand = false;
            continue;
        }

        // Display formats: %9.2f, %-12s, %td, %10.0gc
        const format = rest.match(/^%-?(?:\d+(?:\.\d+)?)?(?:[fgeshxb]c?|t[cCdwmqhyg][^\s,)]*)/);
        if (format && format[0].length > 1) {
            paint(p.number, format[0]);
            i += format[0].length;
            expectCommand = false;
            continue;
        }

        // Numbers (not part of a name, and not factor notation like 2.race or i2.x)
        const num = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
        if (num && (i === 0 || !/[A-Za-z0-9_.]/.test(code[i - 1])) && !/^\d+\.?[A-Za-z_]/.test(rest)) {
            paint(p.number, num[0]);
            i += num[0].length;
            expectCommand = false;
            continue;
        }

        // Words
        const word = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (word) {
            const w = word[0];
            const after = code.slice(i + w.length);
            if (expectCommand) {
                paint(KEYWORDS.has(w.toLowerCase()) ? p.keyword : p.command, w);
                // A prefix (`quietly`, `by g:`) is followed by the real command.
                expectCommand = PREFIX_RE.test(w) && !/^\s*:/.test(after) && !/^(?:by|bys|bysort)$/i.test(w);
            } else if (/^\(/.test(after)) {
                paint(p.func, w);
            } else if (KEYWORDS.has(w.toLowerCase())) {
                paint(p.keyword, w);
            } else {
                out += w;
            }
            i += w.length;
            continue;
        }

        // `prefix:` hands over to a new command (`quietly: reg`, `by g: summarize`)
        if (ch === ':') {
            out += ch;
            expectCommand = true;
            i++;
            continue;
        }

        out += ch;
        if (!/\s/.test(ch)) { expectCommand = false; }
        i++;
    }
    return out;
}

/** Strings, with macros inside them still highlighted. */
function highlightString(text: string, p: HighlightPalette): string {
    let out = '';
    let i = 0;
    let plain = '';
    const flush = () => {
        if (plain) { out += p.string + plain + p.reset; plain = ''; }
    };
    while (i < text.length) {
        // The leading `"` of a compound string is the quote, not a macro.
        if (text[i] === '`' && !(i === 0 && text[1] === '"')) {
            flush();
            const stop = macroEnd(text, i);
            out += p.macro + text.slice(i, stop) + p.reset;
            i = stop;
            continue;
        }
        const global = text.slice(i).match(/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/);
        if (global) {
            flush();
            out += p.macro + global[0] + p.reset;
            i += global[0].length;
            continue;
        }
        plain += text[i];
        i++;
    }
    flush();
    return out;
}

/** End index (exclusive) of a local macro reference starting at `start`, allowing nesting. */
function macroEnd(code: string, start: number): number {
    let depth = 0;
    for (let i = start; i < code.length; i++) {
        if (code[i] === '`') { depth++; }
        else if (code[i] === '\'') {
            depth--;
            if (depth === 0) { return i + 1; }
        }
    }
    return code.length;
}
