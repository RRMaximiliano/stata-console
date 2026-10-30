/**
 * Minimal Stata line scanner shared by the do-file rewriter and the interactive
 * input accumulator. It removes comments and string contents so callers can
 * count braces and detect `///` continuations. No `vscode` dependency.
 */
export interface ScanState {
    /** Nesting depth of an open block comment, carried across lines. */
    blockDepth: number;
}

export interface LineScan {
    /** The line with comments removed and string contents replaced by `""`. */
    code: string;
    /** The line ends with a `///` continuation. */
    continued: boolean;
    /** Index where code ends in the raw line (start of a trailing `//` comment). */
    end: number;
}

function isSpace(ch: string | undefined): boolean {
    return ch === undefined || ch === ' ' || ch === '\t';
}

/**
 * Scan one physical line. `atCommandStart` is false on `///` continuation
 * lines, where a leading `*` is an operator rather than a comment marker.
 */
export function scanLine(line: string, state: ScanState, atCommandStart = true): LineScan {
    let code = '';
    let continued = false;
    let end = line.length;
    let i = 0;
    const n = line.length;

    while (i < n) {
        const ch = line[i];
        const next = line[i + 1];

        if (state.blockDepth > 0) {
            if (ch === '*' && next === '/') {
                state.blockDepth--;
                i += 2;
            } else if (ch === '/' && next === '*') {
                state.blockDepth++;
                i += 2;
            } else {
                i++;
            }
            continue;
        }

        if (ch === '/' && next === '*') {
            state.blockDepth++;
            i += 2;
            continue;
        }

        if (ch === '/' && next === '/' && (i === 0 || isSpace(line[i - 1]))) {
            continued = line[i + 2] === '/';
            end = i;
            break;
        }

        if (ch === '*' && atCommandStart && code.trim() === '') {
            break;
        }

        // Compound quote: `" ... "' (nests, may contain plain quotes)
        if (ch === '`' && next === '"') {
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                if (line[i] === '`' && line[i + 1] === '"') {
                    depth++;
                    i += 2;
                } else if (line[i] === '"' && line[i + 1] === "'") {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            }
            code += '""';
            continue;
        }

        if (ch === '"') {
            i++;
            while (i < n && line[i] !== '"') { i++; }
            i++;
            code += '""';
            continue;
        }

        // ${name} global macro — its braces are not block braces
        if (ch === '$' && next === '{') {
            const close = line.indexOf('}', i + 2);
            code += '$x';
            i = close === -1 ? n : close + 1;
            continue;
        }

        code += ch;
        i++;
    }

    return { code, continued, end };
}

export function countBraces(code: string): number {
    let depth = 0;
    for (const ch of code) {
        if (ch === '{') { depth++; }
        else if (ch === '}') { depth--; }
    }
    return depth;
}

const PREFIX = '(?:(?:quietly|qui|capture|cap|noisily|noi|n)\\s+)*';
const END_BLOCK_RE = new RegExp(
    `^${PREFIX}(?:mata\\s*:?|python\\s*:?|pr(?:o(?:g(?:r(?:a(?:m)?)?)?)?)?\\s+(?!drop\\b|dir\\b|list\\b)\\S+.*|inp(?:u(?:t)?)?(?:\\s+.*)?)$`,
    'i'
);

/**
 * Does this comment-free command open a block that only `end` closes
 * (`mata`, `python`, `program define`, `input`)?
 */
export function startsEndBlock(command: string): boolean {
    return END_BLOCK_RE.test(command.trim());
}
