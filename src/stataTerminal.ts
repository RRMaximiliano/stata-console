import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StataProcess } from './stataProcess';

// Terminal colors — inspired by Stata's Results window
const C = {
    prompt: '\x1b[38;2;78;154;106m',      // muted green for ". " prompt
    cmd:    '\x1b[38;2;86;156;214m',       // soft blue for echoed commands (like Stata)
    err:    '\x1b[38;2;204;62;68m',        // red for errors
    errBg:  '\x1b[38;2;204;62;68m',        // red text for error context
    table:  '\x1b[38;2;180;180;180m',      // light gray for table separators
    dim:    '\x1b[38;2;120;120;120m',      // dim for chrome/info
    bold:   '\x1b[1m',                     // bold
    reset:  '\x1b[0m',
};

const BROWSE_RE = /^(br|bro|brow|brows|browse|ed|edi|edit)\b(.*)$/i;

export class StataTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    private graphEmitter = new vscode.EventEmitter<string>();
    private browseEmitter = new vscode.EventEmitter<{ csvPath: string; totalObs?: number }>();
    private varsUpdatedEmitter = new vscode.EventEmitter<{ obs: number; vars: number; filename: string; label: string }>();
    private resultsUpdatedEmitter = new vscode.EventEmitter<void>();
    private busyEmitter = new vscode.EventEmitter<boolean>();
    private errorEmitter = new vscode.EventEmitter<string>();

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    onDidDetectGraph = this.graphEmitter.event;
    onDidRequestBrowse = this.browseEmitter.event;
    onDidUpdateVariables = this.varsUpdatedEmitter.event;
    onDidUpdateResults = this.resultsUpdatedEmitter.event;
    onDidChangeBusy = this.busyEmitter.event;
    onDidDetectError = this.errorEmitter.event;

    private stataProcess: StataProcess;
    private lineBuffer = '';
    private history: string[] = [];
    private historyIndex = -1;
    private savedLine = '';
    private promptTimer: ReturnType<typeof setTimeout> | null = null;
    private isOpen = false;
    private pendingCode: { code: string; dir?: string } | null = null;
    private recentInteractiveCmds: string[] = [];
    private suppressingInternal = false;

    readonly tempDir: string;
    private tempCounter = 0;
    private graphPath: string;
    private varsPath: string;
    private dirWatcher: fs.FSWatcher | null = null;
    private lastGraphSize = 0;
    private graphDebounce: ReturnType<typeof setTimeout> | null = null;
    private varsDebounce: ReturnType<typeof setTimeout> | null = null;
    private lastGraphMtime = 0;
    private lastVarsMtime = 0;

    constructor(stataPath: string) {
        this.stataProcess = new StataProcess(stataPath);
        this.cleanupOldSessions();
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-vsc-'));
        this.graphPath = path.join(this.tempDir, '_graph.png');
        this.varsPath = path.join(this.tempDir, '_vars.tsv');
        this.writePostDoFile();
    }

    /** Create the post-execution do-file: graph + metadata + variables + results.
     *  Runs via `run` (completely silent). */
    private writePostDoFile(): void {
        const postDoFile = path.join(this.tempDir, '_post.do');
        const metaPath = path.join(this.tempDir, '_meta.txt');
        const resultsPath = path.join(this.tempDir, '_results.tsv');
        const code = [
            // Fallback graph export — catches graphs from nested do-files
            // (inline injection only works for directly-run code)
            `capture graph export "${this.graphPath}", as(png) width(800) replace`,

            // 1. Dataset metadata
            `capture file close _vsc_mh`,
            `local _vsc_obs = _N`,
            `local _vsc_k = c(k)`,
            `local _vsc_fn = c(filename)`,
            `local _vsc_dl : data label`,
            `capture file open _vsc_mh using "${metaPath}", write replace`,
            'capture file write _vsc_mh "`_vsc_obs\'" _tab "`_vsc_k\'" _tab "`_vsc_fn\'" _tab "`_vsc_dl\'"',
            `capture file close _vsc_mh`,

            // 3. Variable list
            `capture file close _vsc_fh`,
            `capture file open _vsc_fh using "${this.varsPath}", write replace`,
            `file write _vsc_fh "name" _tab "type" _tab "format" _tab "label" _n`,
            `capture ds`,
            `if _rc == 0 & "\`r(varlist)'" != "" {`,
            `    foreach v of varlist \`r(varlist)' {`,
            `        local _t : type \`v'`,
            `        local _f : format \`v'`,
            `        local _l : variable label \`v'`,
            `        file write _vsc_fh "\`v'" _tab "\`_t'" _tab "\`_f'" _tab "\`_l'" _n`,
            `    }`,
            `}`,
            `capture file close _vsc_fh`,

            // 4. Stored estimation results (e() scalars + macros)
            `capture file close _vsc_rh`,
            `capture file open _vsc_rh using "${resultsPath}", write replace`,
            `capture file write _vsc_rh "type" _tab "name" _tab "value" _n`,
            `capture {`,
            `    local _elist : e(scalars)`,
            `    foreach s of local _elist {`,
            '        file write _vsc_rh "e" _tab "`s\'" _tab (e(`s\')) _n',
            `    }`,
            `}`,
            `capture {`,
            `    local _mlist : e(macros)`,
            `    foreach s of local _mlist {`,
            '        local _mv `e(`s\')\' ',
            '        file write _vsc_rh "em" _tab "`s\'" _tab "`_mv\'" _n',
            `    }`,
            `}`,
            `capture file close _vsc_rh`,
        ].join('\n');
        fs.writeFileSync(postDoFile, code, 'utf-8');
    }

    private cleanupOldSessions(): void {
        try {
            const tmpBase = os.tmpdir();
            for (const entry of fs.readdirSync(tmpBase)) {
                if (entry.startsWith('stata-vsc-')) {
                    const fullPath = path.join(tmpBase, entry);
                    try {
                        for (const f of fs.readdirSync(fullPath)) {
                            fs.unlinkSync(path.join(fullPath, f));
                        }
                        fs.rmdirSync(fullPath);
                    } catch { /* skip */ }
                }
            }
        } catch { /* ignore */ }
    }

    open(): void {
        this.isOpen = true;

        this.out(
            `\r\n` +
            `${C.cmd}  ___  ____  ____  ____  ____ \xAE${C.reset}\r\n` +
            `${C.cmd} /__    /   ____/   /   ____/${C.reset}\r\n` +
            `${C.cmd} ___/   /   /___/   /   /___/${C.reset}   ${C.bold}Stata Console${C.reset}\r\n` +
            `\r\n` +
            `${C.dim} \u2318\u21E7D   Run do-file / selection\r\n` +
            ` \u2318\u21A9    Run current line\r\n` +
            ` \u2318L    Clear console\r\n` +
            ` \u2303C    Break${C.reset}\r\n\r\n`
        );

        this.stataProcess.on('output', (data: string) => {
            this.handleOutput(data, false);
        });

        this.stataProcess.on('stderr', (data: string) => {
            this.handleOutput(data, true);
        });

        this.stataProcess.on('exit', (code: number | null) => {
            this.out(`\r\n${C.dim}Stata exited (code ${code ?? '?'})${C.reset}\r\n`);
            this.closeEmitter.fire();
        });

        this.stataProcess.on('error', (err: Error) => {
            this.out(`\r\n${C.err}${err.message}${C.reset}\r\n`);
        });

        // Watch for graph and vars files — fires instantly when written
        this.startFileWatchers();

        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.stataProcess.start(workspaceDir);

        if (this.pendingCode !== null) {
            const { code, dir } = this.pendingCode;
            this.pendingCode = null;
            setTimeout(() => this.doSendCode(code, dir), 300);
        }
    }

    close(): void {
        this.clearPromptTimer();
        this.stataProcess.dispose();
        this.cleanupTempDir();
    }

    // --- Interactive keyboard input ---

    handleInput(data: string): void {
        if (data === '\x03') {
            this.stataProcess.interrupt();
            this.lineBuffer = '';
            this.out('^C\r\n');
            this.showPrompt();
            return;
        }

        if (data === '\r') {
            this.out('\r\n');
            const command = this.lineBuffer;
            this.lineBuffer = '';
            this.historyIndex = -1;
            this.savedLine = '';

            if (command.trim().length > 0) {
                if (this.history.length === 0 || this.history[this.history.length - 1] !== command.trim()) {
                    this.history.push(command.trim());
                    if (this.history.length > 1000) { this.history.shift(); }
                }

                // Intercept browse/edit — not available in console mode
                const browseMatch = command.trim().match(BROWSE_RE);
                if (browseMatch) {
                    this.handleBrowse(browseMatch[2]?.trim() || '');
                    return;
                }

                const cleaned = this.stripInlineComments(command);
                this.recentInteractiveCmds.push(cleaned.trim());
                this.busyEmitter.fire(true);
                this.stataProcess.write(cleaned);
            } else {
                this.showPrompt();
            }
            return;
        }

        if (data === '\x7f') {
            if (this.lineBuffer.length > 0) {
                this.lineBuffer = this.lineBuffer.slice(0, -1);
                this.out('\b \b');
            }
            return;
        }

        if (data === '\x1b[A') { this.navigateHistory(1); return; }
        if (data === '\x1b[B') { this.navigateHistory(-1); return; }
        if (data === '\x1b[C' || data === '\x1b[D') { return; }

        this.lineBuffer += data;
        this.out(data);
    }

    // --- Browse (interactive only) ---

    handleBrowse(args: string): void {
        this.out(`${C.dim}(opening Data Viewer...)${C.reset}\r\n`);

        const csvPath = path.join(this.tempDir, '_browse.csv');
        const countPath = path.join(this.tempDir, '_count.txt');
        try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
        try { fs.unlinkSync(countPath); } catch { /* ignore */ }

        const exportArgs = args ? ' ' + args : '';
        const browseDoFile = path.join(this.tempDir, '_browse.do');
        const code = [
            `capture file close _vsc_fh`,
            `capture file open _vsc_fh using "${countPath}", write replace`,
            `capture file write _vsc_fh (_N)`,
            `capture file close _vsc_fh`,
            `capture export delimited${exportArgs} using "${csvPath}", replace`,
        ].join('\n');
        fs.writeFileSync(browseDoFile, code, 'utf-8');
        this.stataProcess.write(`run "${browseDoFile}"`);

        this.waitForFile(csvPath, 500).then(() => {
            let totalObs: number | undefined;
            if (fs.existsSync(countPath)) {
                totalObs = parseInt(fs.readFileSync(countPath, 'utf-8').trim(), 10) || undefined;
            }
            this.browseEmitter.fire({ csvPath, totalObs });
            this.showPrompt();
        }).catch(() => {
            this.browseEmitter.fire({ csvPath: '', totalObs: 0 });
            this.showPrompt();
        });
    }

    // --- Programmatic code execution ---

    sendCode(code: string, workingDir?: string): void {
        if (!this.isOpen) {
            this.pendingCode = { code, dir: workingDir };
            return;
        }
        this.doSendCode(code, workingDir);
    }

    private doSendCode(code: string, workingDir?: string): void {
        this.busyEmitter.fire(true);
        this.recentInteractiveCmds = [];
        this.lastGraphSize = 0; // reset so new graphs are detected
        this.lastGraphMtime = this.getFileMtime(this.graphPath);
        this.lastVarsMtime = this.getFileMtime(this.varsPath);

        // Delete old browse CSV so watcher can detect a new one
        try { fs.unlinkSync(path.join(this.tempDir, '_browse.csv')); } catch { /* ignore */ }

        // Process lines: replace browse/edit (not available in console mode),
        // inject graph export after graph commands
        const csvPath = path.join(this.tempDir, '_browse.csv');
        const countPath = path.join(this.tempDir, '_count.txt');
        const sourceLines = code.split(/\r?\n/);
        const outputLines: string[] = [];
        let inGraphCmd = false;

        for (const line of sourceLines) {
            const trimmed = line.trim();

            // Replace browse/edit with inline export (respects error-stop)
            const browseMatch = trimmed.match(BROWSE_RE);
            if (browseMatch) {
                const exportArgs = browseMatch[2]?.trim() || '';
                const exportCmd = exportArgs
                    ? `capture export delimited ${exportArgs} using "${csvPath}", replace`
                    : `capture export delimited using "${csvPath}", replace`;
                outputLines.push(`* browse — opening in VS Code Data Viewer`);
                outputLines.push(`capture file close _vsc_fh`);
                outputLines.push(`capture file open _vsc_fh using "${countPath}", write replace`);
                outputLines.push(`capture file write _vsc_fh (_N)`);
                outputLines.push(`capture file close _vsc_fh`);
                outputLines.push(exportCmd);
                continue;
            }

            outputLines.push(line);

            // Detect graph-producing commands to inject export after each
            const isContinuation = trimmed.endsWith('///');
            if (!inGraphCmd && this.isGraphCommand(trimmed)) {
                inGraphCmd = true;
            }
            if (inGraphCmd && !isContinuation) {
                inGraphCmd = false;
                outputLines.push(
                    `capture quietly graph export "${this.graphPath}", as(png) width(800) replace`
                );
            }
        }

        const tempFile = path.join(this.tempDir, `_run_${++this.tempCounter}.do`);

        let fullCode = '';
        if (workingDir) {
            fullCode += `cd "${workingDir}"\n`;
        }
        fullCode += outputLines.join('\n') + '\n';

        fs.writeFileSync(tempFile, fullCode, 'utf-8');
        // `do file` stops on error by default. `do file, nostop` would continue.
        // Using plain `do` ensures Stata-like error behavior.
        this.stataProcess.write(`do "${tempFile}"`);

        // Silently run variable metadata
        const postDoFile = path.join(this.tempDir, '_post.do');
        this.stataProcess.write(`run "${postDoFile}"`);

        for (const line of code.split(/\r?\n/)) {
            const t = line.trim();
            if (t && !t.startsWith('*') && !t.startsWith('//')) {
                if (this.history.length === 0 || this.history[this.history.length - 1] !== t) {
                    this.history.push(t);
                }
            }
        }
        this.historyIndex = -1;
    }

    private waitForFile(filePath: string, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            if (fs.existsSync(filePath)) { resolve(); return; }
            const interval = setInterval(() => {
                if (fs.existsSync(filePath)) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 100);
            const timeout = setTimeout(() => {
                clearInterval(interval);
                reject(new Error('timeout'));
            }, timeoutMs);
        });
    }

    // --- Output handling ---

    private handleOutput(data: string, isStderr: boolean): void {
        this.clearPromptTimer();

        const text = data.replace(/\r?\n/g, '\r\n');

        if (isStderr) {
            this.out(`${C.err}${text}${C.reset}`);
        } else {
            this.out(this.colorize(text));
        }

        this.promptTimer = setTimeout(() => {
            this.promptTimer = null;
            this.busyEmitter.fire(false);
            this.showPrompt();
        }, 200);
    }

    private colorize(text: string): string {
        const lines = text.split('\r\n');
        const result: string[] = [];
        let inError = false;

        for (const line of lines) {
            const stripped = line.trimStart();

            // --- Filter internal extension noise ---
            // Use path-based patterns (temp dir name) rather than broad substrings
            if (line.includes('stata-vsc-') ||
                line.includes('capture quietly graph export') ||
                /^\. run "/.test(stripped)) {
                this.suppressingInternal = true;
                continue;
            }

            if (this.suppressingInternal && /^> /.test(stripped)) {
                continue;
            }

            if (stripped === 'end of do-file') {
                continue;
            }

            if (this.suppressingInternal && !/^> /.test(stripped)) {
                this.suppressingInternal = false;
            }

            // Suppress Stata's re-echo of interactively typed commands
            if (/^\. /.test(stripped) && this.recentInteractiveCmds.length > 0) {
                const echoedCmd = stripped.substring(2).trim();
                const idx = this.recentInteractiveCmds.indexOf(echoedCmd);
                if (idx !== -1) {
                    this.recentInteractiveCmds.splice(idx, 1);
                    continue;
                }
            }

            // --- Colorize ---

            // Error codes: r(123);
            if (/^r\(\d+\);/.test(stripped)) {
                result.push(`${C.err}${line}${C.reset}`);
                // Emit error: collect preceding error lines as the message
                const errorLines: string[] = [];
                for (let j = result.length - 2; j >= 0; j--) {
                    const raw = result[j].replace(/\x1b\[[^m]*m/g, '').trim();
                    if (!raw) { break; }
                    errorLines.unshift(raw);
                }
                errorLines.push(stripped);
                this.errorEmitter.fire(errorLines.join('\n'));
                inError = false;
                continue;
            }

            // Continuation of error block
            if (inError) {
                result.push(`${C.errBg}${line}${C.reset}`);
                if (/^r\(\d+\);/.test(stripped)) { inError = false; }
                continue;
            }

            // Error preamble keywords
            if (/^(invalid |unrecognized |unknown |command .* is unrecognized|variable .* not found|no variables defined|option .* not allowed|type mismatch|last estimates not found|no observations|not possible|too few|too many|may not|does not|cannot )/.test(stripped)) {
                result.push(`${C.err}${line}${C.reset}`);
                inError = true;
                continue;
            }

            // Table separator lines (---+--- or ===+===)
            if (/^[-=+|]+$/.test(stripped) || /^[-]+\+[-]+/.test(stripped)) {
                result.push(`${C.table}${line}${C.reset}`);
                continue;
            }

            // Echoed commands: ". command"
            if (/^\. /.test(stripped) || stripped === '.') {
                result.push(`${C.cmd}${line}${C.reset}`);
                continue;
            }

            if (/^> /.test(stripped)) {
                result.push(`${C.cmd}${line}${C.reset}`);
                continue;
            }

            result.push(line);
        }

        return result.join('\r\n');
    }

    // --- File watchers for instant detection ---

    private startFileWatchers(): void {
        // Watch the temp directory — detects when _graph.png or _vars.tsv are written
        try {
            this.dirWatcher = fs.watch(this.tempDir, (_event, filename) => {
                if (!filename) { return; }

                if (filename === '_graph.png') {
                    // Debounce 500ms — Stata writes PNGs in chunks, and
                    // inline + _post.do may both export. Wait for the file
                    // to stabilize before capturing.
                    if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
                    this.graphDebounce = setTimeout(() => {
                        this.graphDebounce = null;
                        try {
                            const stat = fs.statSync(this.graphPath);
                            // Only fire if file is valid AND different from last capture
                            // (deduplicates inline + _post.do double export)
                            if (stat.size > 100 && stat.size !== this.lastGraphSize) {
                                this.lastGraphSize = stat.size;
                                this.graphEmitter.fire(this.graphPath);
                            }
                        } catch { /* ignore */ }
                    }, 500);
                }

                if (filename === '_vars.tsv') {
                    if (this.varsDebounce) { clearTimeout(this.varsDebounce); }
                    this.varsDebounce = setTimeout(() => {
                        this.varsDebounce = null;
                        const mtime = this.getFileMtime(this.varsPath);
                        if (mtime > this.lastVarsMtime) {
                            this.lastVarsMtime = mtime;
                            const meta = this.readMeta();
                            this.varsUpdatedEmitter.fire(meta);
                        }
                    }, 50);
                }

                if (filename === '_results.tsv') {
                    setTimeout(() => {
                        this.resultsUpdatedEmitter.fire();
                    }, 50);
                }

                // Browse CSV written by inline export in do-file
                if (filename === '_browse.csv') {
                    setTimeout(() => {
                        const browseCsv = path.join(this.tempDir, '_browse.csv');
                        const browseCount = path.join(this.tempDir, '_count.txt');
                        if (fs.existsSync(browseCsv)) {
                            let totalObs: number | undefined;
                            try {
                                if (fs.existsSync(browseCount)) {
                                    totalObs = parseInt(fs.readFileSync(browseCount, 'utf-8').trim(), 10) || undefined;
                                }
                            } catch { /* ignore */ }
                            this.browseEmitter.fire({ csvPath: browseCsv, totalObs });
                        }
                    }, 100);
                }
            });
        } catch { /* ignore — watchers are best-effort */ }
    }

    private getFileMtime(filePath: string): number {
        try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
    }

    private readMeta(): { obs: number; vars: number; filename: string; label: string } {
        const metaPath = path.join(this.tempDir, '_meta.txt');
        let obs = 0, vars = 0, filename = '', label = '';
        try {
            if (fs.existsSync(metaPath)) {
                const content = fs.readFileSync(metaPath, 'utf-8').trim();
                const parts = content.split('\t');
                obs = parseInt(parts[0], 10) || 0;
                vars = parseInt(parts[1], 10) || 0;
                filename = (parts[2] || '').replace(/^"|"$/g, '');
                label = (parts[3] || '').replace(/^"|"$/g, '');
            }
        } catch { /* ignore */ }
        return { obs, vars, filename, label };
    }

    /** Check if a line starts a graph-producing Stata command */
    private isGraphCommand(line: string): boolean {
        // Strip leading dot (echoed commands) and whitespace
        const s = line.replace(/^\.\s*/, '').trim().toLowerCase();
        if (!s || s.startsWith('*') || s.startsWith('//')) { return false; }

        // Graph subcommands that DON'T produce plots
        if (/^graph\s+(export|save|describe|dir|drop|rename|display|query|set|use)\b/.test(s)) {
            return false;
        }

        return /^(scatter|histogram|hist|kdensity|twoway|tw|graph\s+(bar|box|pie|dot|hbar|combine|matrix|twoway)|coefplot|binscatter|marginsplot|sts\s+graph|stcurve|qnorm|pnorm|qqplot|gladder|lowess|lpoly)\b/.test(s);
    }

    // --- History navigation ---

    private navigateHistory(direction: number): void {
        if (this.history.length === 0) { return; }
        if (this.historyIndex === -1 && direction === 1) {
            this.savedLine = this.lineBuffer;
        }
        const next = this.historyIndex + direction;
        if (direction === 1 && next >= this.history.length) { return; }
        if (direction === -1 && next < -1) { return; }
        this.historyIndex = next;
        this.out('\r\x1b[K');
        this.out(`${C.prompt}. ${C.reset}`);
        this.lineBuffer = this.historyIndex === -1
            ? this.savedLine
            : this.history[this.history.length - 1 - this.historyIndex];
        this.out(this.lineBuffer);
    }

    // --- Helpers ---

    private stripInlineComments(cmd: string): string {
        const trimmed = cmd.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
            return '';
        }
        let inQuote = false;
        let qChar = '';
        for (let i = 0; i < cmd.length - 1; i++) {
            const ch = cmd[i];
            if (!inQuote && (ch === '"' || ch === '`')) {
                inQuote = true;
                qChar = ch === '`' ? "'" : '"';
            } else if (inQuote && ch === qChar) {
                inQuote = false;
            } else if (!inQuote && ch === '/' && cmd[i + 1] === '/') {
                return cmd.substring(0, i).trimEnd();
            }
        }
        return cmd;
    }

    clearScreen(): void {
        // ANSI: clear entire screen + move cursor to top-left
        this.out('\x1b[2J\x1b[H');
        this.showPrompt();
    }

    private showPrompt(): void {
        this.out(`\r\n${C.prompt}. ${C.reset}`);
    }

    private out(text: string): void {
        this.writeEmitter.fire(text);
    }

    private clearPromptTimer(): void {
        if (this.promptTimer) {
            clearTimeout(this.promptTimer);
            this.promptTimer = null;
        }
    }

    private cleanupTempDir(): void {
        try {
            for (const f of fs.readdirSync(this.tempDir)) {
                fs.unlinkSync(path.join(this.tempDir, f));
            }
            fs.rmdirSync(this.tempDir);
        } catch { /* ignore */ }
    }

    dispose(): void {
        this.clearPromptTimer();
        this.dirWatcher?.close();
        if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
        if (this.varsDebounce) { clearTimeout(this.varsDebounce); }
        this.stataProcess.dispose();
        this.cleanupTempDir();
        this.writeEmitter.dispose();
        this.closeEmitter.dispose();
        this.graphEmitter.dispose();
        this.browseEmitter.dispose();
        this.varsUpdatedEmitter.dispose();
        this.resultsUpdatedEmitter.dispose();
        this.busyEmitter.dispose();
        this.errorEmitter.dispose();
    }
}
