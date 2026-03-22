import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StataProcess } from './stataProcess';

const C = {
    prompt: '\x1b[38;2;28;168;88m',
    cmd:    '\x1b[38;2;28;168;88m',
    err:    '\x1b[38;2;204;0;0m',
    dim:    '\x1b[90m',
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

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    onDidDetectGraph = this.graphEmitter.event;
    onDidRequestBrowse = this.browseEmitter.event;
    onDidUpdateVariables = this.varsUpdatedEmitter.event;
    onDidUpdateResults = this.resultsUpdatedEmitter.event;

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
            // 1. Graph export
            `capture graph export "${this.graphPath}", as(png) width(800) replace`,

            // 2. Dataset metadata
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

    /** Pre-create the browse export do-file template */
    private writeBrowseDoFile(csvPath: string, countPath: string, exportArgs: string): string {
        const browseDoFile = path.join(this.tempDir, '_browse.do');
        const code = [
            `capture file close _vsc_fh`,
            `capture file open _vsc_fh using "${countPath}", write replace`,
            `capture file write _vsc_fh (_N)`,
            `capture file close _vsc_fh`,
            `capture export delimited${exportArgs} using "${csvPath}", replace`,
        ].join('\n');
        fs.writeFileSync(browseDoFile, code, 'utf-8');
        return browseDoFile;
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
            `${C.dim}  ___  ____  ____  ____  ____ \xAE\r\n` +
            ` /__    /   ____/   /   ____/\r\n` +
            ` ___/   /   /___/   /   /___/   Stata Console for VS Code\r\n` +
            `${C.reset}\r\n` +
            `${C.dim} Cmd+Shift+D  Execute do-file / selection\r\n` +
            ` Cmd+Enter    Execute current line\r\n` +
            ` Ctrl+C       Break${C.reset}\r\n\r\n`
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

                // Intercept browse
                const browseMatch = command.trim().match(BROWSE_RE);
                if (browseMatch) {
                    this.handleBrowse(browseMatch[2]?.trim() || '');
                    return;
                }

                const cleaned = this.stripInlineComments(command);
                this.recentInteractiveCmds.push(cleaned.trim());
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

    // --- Browse command ---

    handleBrowse(args: string): void {
        this.out(`${C.dim}(opening Data Viewer...)${C.reset}\r\n`);

        const csvPath = path.join(this.tempDir, '_browse.csv');
        const countPath = path.join(this.tempDir, '_count.txt');
        try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
        try { fs.unlinkSync(countPath); } catch { /* ignore */ }

        let exportArgs = args ? ' ' + args : '';

        const browseDoFile = this.writeBrowseDoFile(csvPath, countPath, exportArgs);

        // `run` is identical to `do` but produces ZERO output — completely silent
        this.stataProcess.write(`run "${browseDoFile}"`);

        this.waitForFile(csvPath, 500).then(() => {
            let totalObs: number | undefined;
            if (fs.existsSync(countPath)) {
                totalObs = parseInt(fs.readFileSync(countPath, 'utf-8').trim(), 10) || undefined;
            }
            this.browseEmitter.fire({ csvPath, totalObs });
            this.showPrompt();
        }).catch(() => {
            // No data — open empty viewer (like Stata does)
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
        this.recentInteractiveCmds = [];
        // Track mtime so we know when the file is updated (not just existing)
        this.lastGraphMtime = this.getFileMtime(this.graphPath);
        this.lastVarsMtime = this.getFileMtime(this.varsPath);

        const tempFile = path.join(this.tempDir, `_run_${++this.tempCounter}.do`);

        let fullCode = '';
        if (workingDir) {
            fullCode += `cd "${workingDir}"\n`;
        }
        fullCode += code + '\n';

        fs.writeFileSync(tempFile, fullCode, 'utf-8');
        this.stataProcess.write(`do "${tempFile}"`);

        // After user's do-file, silently run graph export + variable metadata.
        // `run` produces ZERO output and runs fast since it's not echo'd.
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
            if (/^r\(\d+\);/.test(stripped)) {
                result.push(`${C.err}${line}${C.reset}`);
                inError = false;
                continue;
            }

            if (inError) {
                result.push(`${C.err}${line}${C.reset}`);
                if (/^r\(\d+\);/.test(stripped)) { inError = false; }
                continue;
            }

            if (/^(invalid |unrecognized |unknown |variable .* not found|no variables defined|option .* not allowed|type mismatch|last estimates not found|no observations)/.test(stripped)) {
                result.push(`${C.err}${line}${C.reset}`);
                inError = true;
                continue;
            }

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
                    if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
                    this.graphDebounce = setTimeout(() => {
                        this.graphDebounce = null;
                        const mtime = this.getFileMtime(this.graphPath);
                        if (mtime > this.lastGraphMtime) {
                            this.lastGraphMtime = mtime;
                            try {
                                const stat = fs.statSync(this.graphPath);
                                if (stat.size > 100) {
                                    this.graphEmitter.fire(this.graphPath);
                                }
                            } catch { /* ignore */ }
                        }
                    }, 50);
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
    }
}
