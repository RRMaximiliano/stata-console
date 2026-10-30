import { countBraces, scanLine, startsEndBlock, type ScanState } from './stataLexer';

/**
 * Collects interactively typed lines until they form a complete Stata
 * statement: balanced braces, no pending `///` continuation or block comment,
 * and `mata`/`program`/`input`/`python` blocks closed by `end`.
 * Complete multi-line statements are run through a temp do-file, because piping
 * a lone `{` line to Stata would let our completion sentinel run inside the
 * loop body. No `vscode` dependency.
 */
export type AccumulatedInput =
    /** Nothing to run (blank line or comment-only line). */
    | { kind: 'empty' }
    /** A single complete line that can be piped to Stata as-is. */
    | { kind: 'line'; code: string }
    /** Several lines that must run together as a do-file. */
    | { kind: 'block'; code: string; lines: string[] }
    /** Not valid interactively; `message` explains why. */
    | { kind: 'rejected'; message: string };

const DELIMIT_RE = /^#delimit\b/i;

export class InputAccumulator {
    private lines: string[] = [];
    private depth = 0;
    private state: ScanState = { blockDepth: 0 };
    private continued = false;
    private untilEnd = false;

    /** True while a multi-line statement is incomplete. */
    get pending(): boolean {
        return this.lines.length > 0;
    }

    /** Lines collected so far, plus the shape of the next prompt. */
    get continuation(): { lineNumber: number; kind: 'brace' | 'other' } {
        return {
            lineNumber: this.lines.length + 1,
            kind: this.depth > 0 && !this.untilEnd ? 'brace' : 'other',
        };
    }

    reset(): void {
        this.lines = [];
        this.depth = 0;
        this.state = { blockDepth: 0 };
        this.continued = false;
        this.untilEnd = false;
    }

    /** Feed one physical line. Returns null while more input is needed. */
    push(rawLine: string): AccumulatedInput | null {
        const line = rawLine.replace(/\r$/, '');
        const fresh = this.lines.length === 0;

        if (fresh && line.trim() === '') {
            return { kind: 'empty' };
        }

        if (fresh && DELIMIT_RE.test(line.trim())) {
            return {
                kind: 'rejected',
                message: '#delimit can only be used in do-files. Run the code from a do-file or selection instead.',
            };
        }

        const scan = scanLine(line, this.state, !this.continued);

        if (fresh) {
            if (scan.code.trim() === '' && !scan.continued && this.state.blockDepth === 0) {
                return { kind: 'empty' };
            }
            if (startsEndBlock(scan.code)) {
                this.untilEnd = true;
            }
        } else if (line.trim() === '' && !this.untilEnd) {
            // A blank line inside a block adds nothing to the do-file.
            return null;
        }

        this.lines.push(line);

        if (this.untilEnd) {
            if (!fresh && scan.code.trim().toLowerCase() === 'end') {
                return this.finish();
            }
            return null;
        }

        this.depth += countBraces(scan.code);
        this.continued = scan.continued;

        if (this.state.blockDepth > 0 || this.continued || this.depth > 0) {
            return null;
        }
        return this.finish();
    }

    private finish(): AccumulatedInput {
        const lines = this.lines;
        this.reset();
        if (lines.length === 1) {
            return { kind: 'line', code: lines[0] };
        }
        return { kind: 'block', code: lines.join('\n'), lines };
    }
}
