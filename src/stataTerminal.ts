import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { type StataBackend } from './backend';
import { InputAccumulator } from './inputAccumulator';
import { LineEditor, parseInput, type InputEvent } from './lineEditor';
import { OutputProcessor, type Palette } from './outputProcessor';
import { cleanupStaleSessions, createSessionDir, removeSessionDir } from './sessionDir';
import {
    BROWSE_RE,
    browseArgs,
    buildBrowseHelper,
    buildGraphExportHelper,
    buildPostDoFile,
    rewriteCode,
    stataPathText,
    stataQuote,
} from './stataCode';
import { DARK_HIGHLIGHT, LIGHT_HIGHLIGHT, highlightStata, type HighlightPalette } from './stataHighlight';

/** Convert hex color (#RRGGBB) to ANSI 24-bit escape code */
function hexToAnsi(hex: string): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return `\x1b[38;2;${r};${g};${b}m`;
}

/** Read console colors from user settings, with defaults */
function loadColors(): Palette {
    const cfg = vscode.workspace.getConfiguration('stata.colors');
    return {
        prompt: hexToAnsi(cfg.get<string>('prompt', '#4E9A6A')),
        cmd:    hexToAnsi(cfg.get<string>('command', '#569CD6')),
        err:    hexToAnsi(cfg.get<string>('error', '#CC3E44')),
        errBg:  hexToAnsi(cfg.get<string>('error', '#CC3E44')),
        table:  hexToAnsi(cfg.get<string>('tableSeparator', '#B4B4B4')),
        dim:    hexToAnsi(cfg.get<string>('dim', '#787878')),
        bold:   '\x1b[1m',
        reset:  '\x1b[0m',
    };
}

let C = loadColors();

/** Code colors for the current theme, or undefined when highlighting is off. */
function loadHighlight(): HighlightPalette | undefined {
    if (!vscode.workspace.getConfiguration('stata.console').get<boolean>('syntaxHighlighting', true)) {
        return undefined;
    }
    const kind = vscode.window?.activeColorTheme?.kind;
    // ColorThemeKind: 1 Light, 4 HighContrastLight
    return kind === 1 || kind === 4 ? LIGHT_HIGHLIGHT : DARK_HIGHLIGHT;
}

/** Stata's line width for a terminal this wide (Stata accepts 40-255; tables need 80). */
export function linesizeFor(columns: number): number {
    return Math.max(80, Math.min(255, Math.floor(columns) - 1));
}
const IS_MAC = process.platform === 'darwin';
/** How long Break may take before the console suggests restarting (PyStata). */
const BREAK_GRACE_MS = 4000;
const MAX_HISTORY = 1000;
const MAX_PROGRAMMATIC_HISTORY_LINES = 20;
const GRAPH_DEBOUNCE_MS = 250;
const PARTIAL_LINE_MS = 80;

/** Where in an editor a run came from, so errors can be mapped back to a line. */
export interface RunTarget {
    uri: vscode.Uri;
    /** Best-guess line when an error cannot be matched to a command. */
    line: number;
    /** Range of document lines the executed text came from (inclusive). */
    from: number;
    to: number;
}

export interface StataErrorEvent {
    message: string;
    origin: 'interactive' | 'programmatic';
    target?: RunTarget;
}

interface Batch {
    origin: 'interactive' | 'programmatic';
    target?: RunTarget;
    /** Do-files to delete once the batch is done. */
    files: string[];
    /** Refresh the sidebar panels (the batch ends with the post-run export). */
    refreshState: boolean;
    runId?: number;
    browseBase?: string;
    echoes: { cmd: string; lines: number }[];
}

interface PendingRun {
    code: string;
    workingDir?: string;
    target?: RunTarget;
}

export class StataTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    private graphEmitter = new vscode.EventEmitter<string>();
    private browseEmitter = new vscode.EventEmitter<{ csvPath: string; totalObs?: number }>();
    private varsUpdatedEmitter = new vscode.EventEmitter<{ obs: number; vars: number; filename: string; label: string }>();
    private resultsUpdatedEmitter = new vscode.EventEmitter<void>();
    private busyEmitter = new vscode.EventEmitter<boolean>();
    private errorEmitter = new vscode.EventEmitter<StataErrorEvent>();
    private executionEmitter = new vscode.EventEmitter<'interactive' | 'programmatic'>();

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    onDidDetectGraph = this.graphEmitter.event;
    onDidRequestBrowse = this.browseEmitter.event;
    onDidUpdateVariables = this.varsUpdatedEmitter.event;
    onDidUpdateResults = this.resultsUpdatedEmitter.event;
    onDidChangeBusy = this.busyEmitter.event;
    onDidDetectError = this.errorEmitter.event;
    onDidStartExecution = this.executionEmitter.event;

    private backend: StataBackend;
    private processor: OutputProcessor;
    private editor = new LineEditor();
    private hl: HighlightPalette | undefined;
    private themeListener: vscode.Disposable | undefined;
    /** Stata linesize wanted for the terminal width, and the one last sent. */
    private wantedLinesize: number | undefined;
    private appliedLinesize: number | undefined;
    private accumulator = new InputAccumulator();

    private batches = new Map<number, Batch>();
    /** `done` events that arrived before `execute` returned the batch id. */
    private earlyDone = new Set<number>();
    private history: string[] = [];
    private historyIndex = -1;
    private savedLine = '';
    private isOpen = false;
    private closed = false;
    private promptShown = false;
    private pendingRuns: PendingRun[] = [];
    private partialTimer: ReturnType<typeof setTimeout> | null = null;

    readonly tempDir: string;
    private tempCounter = 0;
    private graphPath: string;
    private browseHelper: string;
    private graphHelper: string;
    private postDoFile: string;
    private dirWatcher: fs.FSWatcher | null = null;
    private graphDebounce: ReturnType<typeof setTimeout> | null = null;
    private emittedCaptures = new Set<string>();
    private captureHashes = new Map<number, string>();
    private lastFallbackMtime = 0;
    private lastBrowseCsv = '';

    /** `startDir`: Stata's initial working directory (default: the workspace folder). */
    constructor(backend: StataBackend, private readonly startDir?: string) {
        this.backend = backend;
        cleanupStaleSessions();
        this.tempDir = createSessionDir();
        this.graphPath = path.join(this.tempDir, '_graph.png');
        this.browseHelper = path.join(this.tempDir, '_browse.do');
        this.postDoFile = path.join(this.tempDir, '_post.do');
        fs.writeFileSync(this.browseHelper, buildBrowseHelper(this.tempDir), 'utf-8');
        this.graphHelper = path.join(this.tempDir, '_graph_export.do');
        fs.writeFileSync(this.graphHelper, buildGraphExportHelper(), 'utf-8');
        fs.writeFileSync(this.postDoFile, buildPostDoFile({
            meta: path.join(this.tempDir, '_meta.txt'),
            vars: path.join(this.tempDir, '_vars.tsv'),
            results: path.join(this.tempDir, '_results.tsv'),
            graph: this.graphPath,
            graphSig: path.join(this.tempDir, '_graph.sig'),
        }), 'utf-8');

        this.processor = new OutputProcessor({
            palette: C,
            internalMarkers: [stataPathText(this.tempDir)],
            highlight: (code, statementStart) => this.highlight(code, statementStart),
            spaceCommands: true,
            onError: (message) => {
                const first = this.batches.values().next().value as Batch | undefined;
                this.errorEmitter.fire({
                    message,
                    origin: first?.origin ?? 'interactive',
                    target: first?.target,
                });
            },
        });
    }

    open(): void {
        this.isOpen = true;
        C = loadColors(); // pick up any settings changes
        this.processor.setPalette(C);
        this.hl = loadHighlight();
        this.editor.highlight = (text) => this.highlight(text, this.inputStartsStatement());
        this.themeListener = vscode.window?.onDidChangeActiveColorTheme?.(() => { this.hl = loadHighlight(); });

        const run = IS_MAC ? '⌘⇧D' : 'Ctrl+Shift+D';
        const line = IS_MAC ? '⌘↩ / Shift+Enter' : 'Ctrl+Enter / Shift+Enter';
        const clear = IS_MAC ? '⌘L' : 'Ctrl+L';
        const brk = IS_MAC ? '⌃C' : 'Ctrl+C';
        this.out(
            `\r\n` +
            `${C.cmd}  ___  ____  ____  ____  ____ \xAE${C.reset}\r\n` +
            `${C.cmd} /__    /   ____/   /   ____/${C.reset}\r\n` +
            `${C.cmd} ___/   /   /___/   /   /___/${C.reset}   ${C.bold}Stata Console${C.reset}\r\n` +
            `\r\n` +
            `${C.dim} ${run}   Run do-file / selection\r\n` +
            ` ${line}    Run current line\r\n` +
            ` ${clear}    Clear console\r\n` +
            ` ${brk}    Break${C.reset}\r\n\r\n`
        );

        this.backend.on('output', (data: string) => this.handleOutput(data));

        this.backend.on('stderr', (data: string) => this.write(this.processor.writeStderr(data)));

        this.backend.on('done', (batchId: number) => this.handleDone(batchId));

        this.backend.on('ready', () => {
            if (this.batches.size === 0) {
                this.showPrompt();
            }
        });

        this.backend.on('exit', (code: number | null) => {
            this.flushPartial();
            this.abandonBatches();
            this.out(`\r\n${C.dim}Stata exited (code ${code ?? '?'})${C.reset}\r\n`);
            this.closeEmitter.fire();
        });

        this.backend.on('error', (err: Error) => {
            this.beginOutput();
            this.out(`\r\n${C.err}${err.message}${C.reset}\r\n`);
            if (!this.backend.isRunning()) {
                // Nothing will ever complete these batches.
                this.abandonBatches();
                this.showPrompt();
            }
        });

        this.startGraphWatcher();

        const workspaceDir = this.startDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.out(`${C.dim}${this.backend.label}${C.reset}\r\n`);
        if (this.backend.kind === 'pystata') {
            this.out(`${C.dim}Starting Stata…${C.reset}\r\n`);
        }
        this.backend.start(workspaceDir || os.homedir());

        for (const run of this.pendingRuns.splice(0)) {
            this.doSendCode(run.code, run.workingDir, run.target);
        }
    }

    /** Called by VS Code when the terminal is closed. */
    close(): void {
        this.shutdown();
    }

    // --- Interactive keyboard input ---

    handleInput(data: string): void {
        if (this.closed) { return; }
        const events = parseInput(data);
        events.forEach((event, i) => this.handleEvent(event, i < events.length - 1));
    }

    private handleEvent(event: InputEvent, moreFollows: boolean): void {
        if (event.type === 'text') {
            this.out(this.editor.insert(event.text));
            return;
        }
        switch (event.key) {
            case 'interrupt': return this.interrupt();
            case 'enter': return this.submitLine(moreFollows);
            case 'backspace': return this.out(this.editor.backspace());
            case 'delete': return this.out(this.editor.delete());
            case 'left': return this.out(this.editor.left());
            case 'right': return this.out(this.editor.right());
            case 'home': return this.out(this.editor.home());
            case 'end': return this.out(this.editor.end());
            case 'kill-line': return this.out(this.editor.killLine());
            case 'kill-to-end': return this.out(this.editor.killToEnd());
            case 'kill-word': return this.out(this.editor.killWord());
            case 'up': return this.navigateHistory(1);
            case 'down': return this.navigateHistory(-1);
        }
    }

    /** Ctrl+C: break the running command and abandon any half-typed input. */
    interrupt(): void {
        this.backend.interrupt();
        this.editor.clear();
        this.accumulator.reset();
        this.historyIndex = -1;
        this.promptShown = false;
        this.out('^C\r\n');
        if (this.batches.size === 0) {
            this.showPrompt();
        } else if (this.backend.kind === 'pystata') {
            this.warnIfBreakIgnored(new Set(this.batches.keys()));
        }
    }

    /**
     * Break cannot end a PyStata command that is waiting for keyboard input
     * (`pause`, `input`, an interactive `mata` prompt); offer a restart.
     */
    private warnIfBreakIgnored(running: Set<number>): void {
        setTimeout(() => {
            if (this.closed || ![...running].some((id) => this.batches.has(id))) { return; }
            this.beginOutput();
            this.out(`${C.err}Stata did not respond to Break. It may be waiting for keyboard input `
                + `(pause, input, or a mata prompt), which the PyStata backend cannot provide.${C.reset}\r\n`);
            void vscode.window.showWarningMessage(
                'Stata did not respond to Break. It may be waiting for keyboard input (pause, input, or mata).',
                'Restart Stata',
            ).then((choice) => {
                if (choice === 'Restart Stata') {
                    void vscode.commands.executeCommand('stata.restartStata');
                }
            });
        }, BREAK_GRACE_MS);
    }

    private submitLine(moreFollows: boolean): void {
        const text = this.editor.text;
        this.editor.clear();
        this.historyIndex = -1;
        this.savedLine = '';
        this.promptShown = false;
        this.out('\r\n');

        if (text.trim().length > 0 && this.history[this.history.length - 1] !== text.trim()) {
            this.history.push(text.trim());
            if (this.history.length > MAX_HISTORY) { this.history.shift(); }
        }

        const result = this.accumulator.push(text);
        if (result === null) {
            this.showContinuationPrompt();
            return;
        }

        switch (result.kind) {
            case 'empty':
                break;
            case 'rejected':
                this.out(`${C.err}${result.message}${C.reset}\r\n`);
                break;
            case 'line': {
                const browse = result.code.trim().match(BROWSE_RE);
                this.executionEmitter.fire('interactive');
                if (browse) {
                    this.handleBrowse(this.stripComment(browse[2]));
                } else {
                    this.runInteractive([result.code], { cmd: result.code, lines: 1 });
                }
                break;
            }
            case 'block': {
                this.executionEmitter.fire('interactive');
                const runId = ++this.tempCounter;
                // Same rewriting as Run: browse opens the viewer and every graph is captured.
                const rewritten = this.rewrite(result.code, runId);
                const file = path.join(this.tempDir, `_int_${runId}.do`);
                fs.writeFileSync(file, rewritten.code, 'utf-8');
                this.runInteractive([`do ${stataQuote(file)}`], { cmd: result.lines[0], lines: result.lines.length }, file,
                    { runId, browseBase: rewritten.browseBase });
                break;
            }
        }

        if (this.batches.size === 0) {
            this.showPrompt();
        } else if (moreFollows) {
            // Pasted text: show a prompt per line while the earlier lines run.
            this.out(this.promptText());
        }
    }

    private runInteractive(
        commands: string[],
        echo: { cmd: string; lines: number },
        file?: string,
        capture?: { runId: number; browseBase?: string },
    ): void {
        this.submit([...commands, `run ${stataQuote(this.postDoFile)}`], {
            origin: 'interactive',
            files: file ? [file] : [],
            refreshState: true,
            echoes: [echo],
            ...capture,
        });
    }

    private rewrite(code: string, runId: number): ReturnType<typeof rewriteCode> {
        return rewriteCode(code, {
            dir: this.tempDir,
            runId,
            browseLimit: this.browseLimit(),
            browseHelper: this.browseHelper,
            graphHelper: this.graphHelper,
        });
    }

    private stripComment(text: string): string {
        const i = text.search(/(?:^|\s)\/\//);
        return (i === -1 ? text : text.slice(0, i)).trim();
    }

    // --- Browse ---

    /** Export the data in memory for the Data Viewer. */
    handleBrowse(args: string): void {
        this.beginOutput();
        this.out(`${C.dim}(opening Data Viewer...)${C.reset}\r\n`);
        const base = `_browse_i${++this.tempCounter}`;
        this.submit([`quietly run ${stataQuote(this.browseHelper)} ${this.browseLimit()} ${base} ${browseArgs(args)}`], {
            origin: 'interactive',
            files: [],
            refreshState: false,
            browseBase: base,
            echoes: [],
        });
    }

    private browseLimit(): number {
        const limit = vscode.workspace.getConfiguration('stata').get<number>('browseRowLimit', 10000);
        return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10000;
    }

    private emitBrowse(base: string): void {
        const csvPath = path.join(this.tempDir, `${base}.csv`);
        const countPath = path.join(this.tempDir, `${base}.count`);
        let totalObs: number | undefined;
        try {
            totalObs = parseInt(fs.readFileSync(countPath, 'utf-8').trim(), 10);
            if (!Number.isFinite(totalObs)) { totalObs = undefined; }
        } catch { /* no count file: the export failed and Stata printed why */ }

        if (fs.existsSync(csvPath)) {
            if (this.lastBrowseCsv && this.lastBrowseCsv !== csvPath) {
                try { fs.unlinkSync(this.lastBrowseCsv); } catch { /* ignore */ }
            }
            this.lastBrowseCsv = csvPath;
            this.browseEmitter.fire({ csvPath, totalObs });
        } else if (totalObs === 0) {
            this.browseEmitter.fire({ csvPath: '', totalObs: 0 });
        }
    }

    // --- Batches ---

    /** Submit commands to the backend, tracking busy state until `done`. */
    private submit(commands: string[], batch: Batch): number {
        const wasIdle = this.batches.size === 0;
        if (this.wantedLinesize !== undefined && this.wantedLinesize !== this.appliedLinesize) {
            const set = `quietly set linesize ${this.wantedLinesize}`;
            commands = [set, ...commands];
            batch = { ...batch, echoes: [{ cmd: set, lines: 1 }, ...batch.echoes] };
            this.appliedLinesize = this.wantedLinesize;
        }
        this.beginOutput();
        let id: number;
        try {
            id = this.backend.execute(commands);
        } catch (err) {
            this.out(`${C.err}${(err as Error).message}${C.reset}\r\n`);
            this.cleanupFiles(batch.files);
            return -1;
        }
        if (!this.backend.isRunning()) {
            // The backend reported an error instead of accepting the batch.
            this.cleanupFiles(batch.files);
            return -1;
        }
        for (const echo of batch.echoes) {
            this.processor.expectEcho(id, echo.cmd, echo.lines);
        }
        if (this.earlyDone.delete(id)) {
            this.finishBatch(id, batch, wasIdle);
            return id;
        }
        this.batches.set(id, batch);
        if (wasIdle) { this.busyEmitter.fire(true); }
        return id;
    }

    private handleDone(batchId: number): void {
        const batch = this.batches.get(batchId);
        if (!batch) {
            this.earlyDone.add(batchId);
            return;
        }
        this.batches.delete(batchId);
        this.finishBatch(batchId, batch, false);
    }

    private finishBatch(batchId: number, batch: Batch, neverBusy: boolean): void {
        this.flushPartial();
        this.processor.batchDone(batchId);

        this.sweepGraphs(true, batch.runId);
        if (batch.refreshState) {
            this.varsUpdatedEmitter.fire(this.readMeta());
            this.resultsUpdatedEmitter.fire();
        }
        if (batch.browseBase) {
            this.emitBrowse(batch.browseBase);
        }
        this.cleanupFiles(batch.files);

        if (this.batches.size === 0) {
            if (!neverBusy) { this.busyEmitter.fire(false); }
            this.showPrompt();
        }
    }

    /** The backend is gone: no outstanding batch can complete. */
    private abandonBatches(): void {
        const wasBusy = this.batches.size > 0;
        for (const batch of this.batches.values()) { this.cleanupFiles(batch.files); }
        this.batches.clear();
        this.earlyDone.clear();
        this.processor.reset();
        if (wasBusy) { this.busyEmitter.fire(false); }
    }

    private cleanupFiles(files: string[]): void {
        for (const f of files) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    }

    // --- Programmatic code execution ---

    sendCode(code: string, workingDir?: string, target?: RunTarget): void {
        if (this.closed) { return; }
        if (!this.isOpen) {
            this.pendingRuns.push({ code, workingDir, target });
            return;
        }
        this.doSendCode(code, workingDir, target);
    }

    private doSendCode(code: string, workingDir?: string, target?: RunTarget): void {
        this.executionEmitter.fire('programmatic');

        const runId = ++this.tempCounter;
        const rewritten = this.rewrite(code, runId);
        const tempFile = path.join(this.tempDir, `_run_${runId}.do`);
        fs.writeFileSync(tempFile, rewritten.code, 'utf-8');

        // `do file` stops on error like Stata does; the post-run export is
        // a separate command so it still runs after an error or break.
        const commands: string[] = [];
        const echoes: Batch['echoes'] = [];
        if (workingDir) {
            const cd = `quietly cd ${stataQuote(workingDir)}`;
            commands.push(cd);
            echoes.push({ cmd: cd, lines: 1 });
        }
        commands.push(`do ${stataQuote(tempFile)}`, `run ${stataQuote(this.postDoFile)}`);

        this.submit(commands, {
            origin: 'programmatic',
            target,
            files: [tempFile],
            refreshState: true,
            runId,
            browseBase: rewritten.browseBase,
            echoes,
        });

        const meaningful = code.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('*') && !l.startsWith('//'));
        if (meaningful.length <= MAX_PROGRAMMATIC_HISTORY_LINES) {
            for (const t of meaningful) {
                if (this.history[this.history.length - 1] !== t) { this.history.push(t); }
            }
            if (this.history.length > MAX_HISTORY) { this.history.splice(0, this.history.length - MAX_HISTORY); }
        }
        this.historyIndex = -1;
    }

    // --- Output handling ---

    private handleOutput(data: string): void {
        this.write(this.processor.write(data));
        // Prompts and `--more--` arrive without a newline; flush them if nothing follows.
        if (this.partialTimer) { clearTimeout(this.partialTimer); }
        this.partialTimer = setTimeout(() => {
            this.partialTimer = null;
            this.flushPartial();
        }, PARTIAL_LINE_MS);
    }

    private flushPartial(): void {
        if (this.partialTimer) {
            clearTimeout(this.partialTimer);
            this.partialTimer = null;
        }
        this.write(this.processor.flushPending());
    }

    /** Write Stata output, first wiping a prompt left on the current line. */
    private write(text: string): void {
        if (!text) { return; }
        this.beginOutput();
        this.out(text);
    }

    /** Output is about to be written: wipe a prompt left on the current line. */
    private beginOutput(): void {
        if (this.promptShown) {
            this.promptShown = false;
            this.out('\r\x1b[2K');
        }
    }

    // --- Graph capture ---

    private startGraphWatcher(): void {
        // Events are only a hint: the file name can be missing (Windows) and
        // events can repeat, so each debounced event rescans the directory.
        try {
            this.dirWatcher = fs.watch(this.tempDir, () => {
                if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
                this.graphDebounce = setTimeout(() => {
                    this.graphDebounce = null;
                    this.sweepGraphs(false);
                }, GRAPH_DEBOUNCE_MS);
            });
            this.dirWatcher.on('error', () => { /* best-effort */ });
        } catch { /* ignore — graphs are still picked up when a batch finishes */ }
    }

    /**
     * Emit new plots: inline captures (`_cap_<run>_<n>.png`) in order, then,
     * once a batch is finished, the fallback export of the current graph.
     */
    private sweepGraphs(final: boolean, runId?: number): void {
        let names: string[];
        try { names = fs.readdirSync(this.tempDir); } catch { return; }

        const captures = names
            .map((name) => ({ name, m: name.match(/^_cap_(\d+)_(\d+)\.png$/) }))
            .filter((c): c is { name: string; m: RegExpMatchArray } => c.m !== null && !this.emittedCaptures.has(c.name))
            .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2]) - Number(b.m[2]));

        let unsettled = false;
        for (const { name, m } of captures) {
            const file = path.join(this.tempDir, name);
            let stat: fs.Stats;
            try { stat = fs.statSync(file); } catch { continue; }
            if (stat.size <= 100) { continue; }
            if (!final && Date.now() - stat.mtimeMs < 150) {
                unsettled = true; // possibly still being written
                break;
            }
            this.emittedCaptures.add(name);
            const hash = this.hashFile(file);
            if (hash) { this.captureHashes.set(Number(m[1]), hash); }
            this.graphEmitter.fire(file);
        }
        if (unsettled) {
            if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
            this.graphDebounce = setTimeout(() => {
                this.graphDebounce = null;
                this.sweepGraphs(false);
            }, GRAPH_DEBOUNCE_MS);
        }

        if (!final) { return; }
        let stat: fs.Stats;
        try { stat = fs.statSync(this.graphPath); } catch { return; }
        if (stat.size <= 100 || stat.mtimeMs === this.lastFallbackMtime) { return; }
        this.lastFallbackMtime = stat.mtimeMs;
        // The graph an inline capture of this same run already showed is not new.
        const hash = this.hashFile(this.graphPath);
        if (runId !== undefined && hash && hash === this.captureHashes.get(runId)) { return; }
        this.graphEmitter.fire(this.graphPath);
    }

    private hashFile(file: string): string | undefined {
        try {
            return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
        } catch {
            return undefined;
        }
    }

    private readMeta(): { obs: number; vars: number; filename: string; label: string } {
        let obs = 0, vars = 0, filename = '', label = '';
        try {
            const content = fs.readFileSync(path.join(this.tempDir, '_meta.txt'), 'utf-8').replace(/\r?\n$/, '');
            const parts = content.split('\t');
            obs = parseInt(parts[0], 10) || 0;
            vars = parseInt(parts[1], 10) || 0;
            filename = (parts[2] || '').trim();
            label = (parts[3] || '').trim();
        } catch { /* ignore */ }
        return { obs, vars, filename, label };
    }

    // --- History navigation ---

    private navigateHistory(direction: number): void {
        if (this.history.length === 0) { return; }
        if (this.historyIndex === -1 && direction === 1) {
            this.savedLine = this.editor.text;
        }
        const next = this.historyIndex + direction;
        if (direction === 1 && next >= this.history.length) { return; }
        if (direction === -1 && next < -1) { return; }
        this.historyIndex = next;
        this.out(this.editor.set(this.historyIndex === -1
            ? this.savedLine
            : this.history[this.history.length - 1 - this.historyIndex]));
    }

    // --- Highlighting and width ---

    private highlight(code: string, statementStart: boolean): string {
        return this.hl ? highlightStata(code, this.hl, statementStart) : `${C.cmd}${code}${C.reset}`;
    }

    /** The line being typed starts a statement unless it continues a `///` or comment. */
    private inputStartsStatement(): boolean {
        return !this.accumulator.pending || this.accumulator.continuation.kind === 'brace';
    }

    /** VS Code reports the terminal size; Stata's linesize follows it from the next command. */
    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.editor.columns = dimensions.columns;
        if (vscode.workspace.getConfiguration('stata.console').get<boolean>('matchTerminalWidth', true)) {
            this.wantedLinesize = linesizeFor(dimensions.columns);
        }
    }

    // --- Prompt ---

    /** Stata-style prompt: `. ` normally, `  2. ` inside a brace block, `> ` otherwise. */
    private promptText(): string {
        let text = '. ';
        if (this.accumulator.pending) {
            const { lineNumber, kind } = this.accumulator.continuation;
            text = kind === 'brace' ? `${String(lineNumber).padStart(3)}. ` : '> ';
        }
        this.editor.prompt = `${C.prompt}${text}${C.reset}`;
        return this.editor.prompt;
    }

    private showPrompt(): void {
        if (this.closed || this.promptShown) { return; }
        this.promptShown = true;
        this.out(this.processor.midLine ? '\r\n\r\n' : '\r\n');
        this.promptText();
        this.out(this.editor.redraw());
    }

    private showContinuationPrompt(): void {
        this.promptShown = true;
        this.out(this.promptText());
    }

    clearScreen(): void {
        // ANSI: clear entire screen + move cursor to top-left
        this.out('\x1b[2J\x1b[H');
        this.promptShown = false;
        if (this.batches.size === 0) {
            this.showPrompt();
        }
    }

    private out(text: string): void {
        if (text && !this.closed) { this.writeEmitter.fire(text); }
    }

    // --- Teardown ---

    private shutdown(): void {
        if (this.closed) { return; }
        this.closed = true;
        this.dirWatcher?.close();
        this.themeListener?.dispose();
        this.dirWatcher = null;
        if (this.graphDebounce) { clearTimeout(this.graphDebounce); }
        if (this.partialTimer) { clearTimeout(this.partialTimer); }
        const wasBusy = this.batches.size > 0;
        this.batches.clear();
        this.pendingRuns = [];
        this.backend.dispose();
        removeSessionDir(this.tempDir);
        if (wasBusy) { this.busyEmitter.fire(false); }
    }

    dispose(): void {
        this.shutdown();
        this.writeEmitter.dispose();
        this.closeEmitter.dispose();
        this.graphEmitter.dispose();
        this.browseEmitter.dispose();
        this.varsUpdatedEmitter.dispose();
        this.resultsUpdatedEmitter.dispose();
        this.busyEmitter.dispose();
        this.errorEmitter.dispose();
        this.executionEmitter.dispose();
    }
}
