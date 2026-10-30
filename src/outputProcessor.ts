/**
 * Turns raw Stata output into colored terminal text. It works on whole lines
 * regardless of how the backend chunks its output, removes the extension's own
 * helper commands and the echo of interactively typed commands, and reports
 * Stata errors. No `vscode` dependency.
 */
export interface Palette {
    prompt: string;
    cmd: string;
    err: string;
    errBg: string;
    table: string;
    dim: string;
    bold: string;
    reset: string;
}

export interface OutputProcessorOptions {
    palette: Palette;
    /** Lines containing any of these substrings come from the extension's own commands. */
    internalMarkers: string[];
    /** Called once per Stata error with the message lines (including `r(N);`). */
    onError?: (message: string) => void;
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const ERROR_CODE_RE = /^r\(\d+\);/;
const ERROR_PREAMBLE_RE = /^(invalid |unrecognized |unknown |command .* is unrecognized|variable .* not found|no variables defined|option .* not allowed|type mismatch|last estimates not found|no observations|not possible|too few|too many|may not|does not|cannot )/;
// Commands the extension generates quote their file argument with a compound quote.
// The path must be in the session dir, so user commands like `do `"$root/x.do"'` stay visible.
const INTERNAL_COMMAND_RE = /^\.\s+(?:(?:capture|quietly)\s+)*(?:do|run|cd|graph export)\s+`"(.*)$/;
const BLANK = Symbol('blank');
const PROMPT_ARTIFACT_RE = /^[.:>] ?$/;
const NUMBERED_CONTINUATION_RE = /^\s*\d+\.(?: |$)/;

export class OutputProcessor {
    private pending = '';
    /** The unterminated line that was flushed early, and whether it was shown. */
    private flushed: { text: string; shown: boolean } | null = null;
    /** A blank line seen but not yet emitted; blank runs collapse and hidden lines swallow it. */
    private pendingBlank = false;
    private hidingInternal = false;
    private hidingEcho = false;
    private echoDepth = 0;
    private inError = false;
    private afterEndOfDoFile = false;
    private errorBlock: string[] = [];
    private expectedEchoes: { batchId: number; cmd: string; lines: number }[] = [];
    private palette: Palette;

    constructor(private readonly options: OutputProcessorOptions) {
        this.palette = options.palette;
    }

    setPalette(palette: Palette): void {
        this.palette = palette;
    }

    /**
     * Stata echoes piped commands as `. cmd`; the user already saw them typed,
     * so the echo of this command is hidden. `lines` is the number of physical
     * lines in a multi-line block (their echo is `. first`, `  2. next`, ...).
     */
    expectEcho(batchId: number, cmd: string, lines = 1): void {
        this.expectedEchoes.push({ batchId, cmd: cmd.trim(), lines });
    }

    /** Forget unmatched echo expectations once their batch has finished. */
    batchDone(batchId: number): void {
        this.expectedEchoes = this.expectedEchoes.filter((e) => e.batchId !== batchId);
        this.hidingEcho = false;
        this.hidingInternal = false;
        this.pendingBlank = false;
    }

    reset(): void {
        this.pending = '';
        this.flushed = null;
        this.pendingBlank = false;
        this.hidingInternal = false;
        this.hidingEcho = false;
        this.inError = false;
        this.afterEndOfDoFile = false;
        this.errorBlock = [];
        this.expectedEchoes = [];
    }

    /** Text arrives in arbitrary chunks; only complete lines are processed. */
    write(chunk: string): string {
        const parts = (this.pending + chunk.replace(/\r\n/g, '\n')).split('\n');
        this.pending = parts.pop() ?? '';
        const out: string[] = [];

        for (let i = 0; i < parts.length; i++) {
            let line = parts[i].replace(/\r$/, '');
            if (i === 0 && this.flushed) {
                // Completes a line whose start was already flushed.
                const { text, shown } = this.flushed;
                this.flushed = null;
                if (shown) {
                    out.push(line + '\r\n');
                    continue;
                }
                line = text + line;
            }
            const processed = this.processLine(line);
            if (processed === null) {
                this.pendingBlank = false;
            } else if (processed === BLANK) {
                this.pendingBlank = true;
            } else {
                if (this.pendingBlank) { out.push('\r\n'); }
                this.pendingBlank = false;
                out.push(processed + '\r\n');
            }
        }
        return out.join('');
    }

    /**
     * Emit an unterminated trailing line (a prompt or `--more--`) that nothing
     * has completed after a short wait. Stata's own bare prompts are held back
     * and rejoined with whatever follows.
     */
    flushPending(): string {
        const line = this.pending;
        if (!line) { return ''; }
        this.pending = '';
        if (PROMPT_ARTIFACT_RE.test(line)) {
            this.flushed = { text: line, shown: false };
            return '';
        }
        const processed = this.processLine(line.replace(/\r$/, ''));
        if (processed === null || processed === BLANK) {
            this.flushed = { text: line, shown: false };
            return '';
        }
        this.flushed = { text: line, shown: true };
        const lead = this.pendingBlank ? '\r\n' : '';
        this.pendingBlank = false;
        return lead + processed;
    }

    /** True when the last text written ended without a newline. */
    get midLine(): boolean {
        return this.flushed?.shown === true || this.pending.length > 0;
    }

    /** Backend diagnostics: shown in the error color, never parsed. */
    writeStderr(chunk: string): string {
        const p = this.palette;
        return `${p.err}${chunk.replace(/\r?\n/g, '\r\n')}${p.reset}`;
    }

    /** An extension-generated command; Stata may wrap its path onto `> ` lines. */
    private isInternalCommand(stripped: string): boolean {
        const match = stripped.match(INTERNAL_COMMAND_RE);
        if (!match) { return false; }
        const fragment = match[1];
        return this.options.internalMarkers.some((m) => m && (fragment.includes(m) || m.startsWith(fragment)));
    }

    private processLine(line: string): string | typeof BLANK | null {
        const p = this.palette;
        const stripped = line.trimStart();
        const isContinuation = /^> /.test(stripped);

        // --- Filter the extension's own commands ---
        if (this.isInternalCommand(stripped) || this.options.internalMarkers.some((m) => m && line.includes(m))) {
            this.hidingInternal = true;
            return null;
        }
        if (this.hidingInternal) {
            if (isContinuation) { return null; }
            this.hidingInternal = false;
        }

        if (stripped === 'end of do-file') {
            this.afterEndOfDoFile = true;
            return null;
        }

        // --- Hide the echo of commands the user typed ---
        if (this.hidingEcho) {
            if (isContinuation || (this.echoDepth > 0 && NUMBERED_CONTINUATION_RE.test(line))) {
                if (!isContinuation) { this.echoDepth--; }
                return null;
            }
            this.hidingEcho = false;
            this.echoDepth = 0;
        }
        if (/^\. /.test(stripped) && this.expectedEchoes.length > 0) {
            const echoed = stripped.substring(2).trim();
            const idx = this.expectedEchoes.findIndex((e) => e.cmd === echoed || (echoed !== '' && e.cmd.startsWith(echoed)));
            if (idx !== -1) {
                const [match] = this.expectedEchoes.splice(idx, 1);
                this.hidingEcho = true;
                this.echoDepth = match.lines - 1;
                return null;
            }
        }

        // --- Errors ---
        if (stripped === '') {
            this.errorBlock = [];
            this.inError = false;
            return BLANK;
        }
        // The prompt Stata prints at do-file level between commands
        if (/^\.\s*$/.test(line)) {
            return null;
        }
        if (ERROR_CODE_RE.test(stripped)) {
            const repeated = this.afterEndOfDoFile;
            this.afterEndOfDoFile = false;
            this.inError = false;
            if (repeated) {
                // Stata repeats the code after `end of do-file`; show it once.
                this.errorBlock = [];
                return null;
            }
            // Report from the command that failed, not the echoed lines before it.
            let start = this.errorBlock.length;
            while (start > 0 && !/^\. /.test(this.errorBlock[start - 1])) { start--; }
            const from = start > 0 ? start - 1 : 0;
            this.options.onError?.([...this.errorBlock.slice(from).map((l) => l.trim()), stripped].join('\n'));
            this.errorBlock = [];
            return `${p.err}${line}${p.reset}`;
        }
        this.afterEndOfDoFile = false;
        this.errorBlock.push(line);

        if (this.inError) {
            return `${p.errBg}${line}${p.reset}`;
        }
        if (ERROR_PREAMBLE_RE.test(stripped)) {
            this.inError = true;
            return `${p.err}${line}${p.reset}`;
        }

        // --- Colorize ---
        if (/^[-=+|]+$/.test(stripped) || /^[-]+\+[-]+/.test(stripped)) {
            return `${p.table}${line}${p.reset}`;
        }
        if (/^\. /.test(stripped) || stripped === '.' || isContinuation) {
            return `${p.cmd}${line}${p.reset}`;
        }
        return line;
    }

    /** Strip color codes (for tests and message extraction). */
    static plain(text: string): string {
        return text.replace(ANSI_ESCAPE_RE, '');
    }
}
