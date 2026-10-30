import { spawn, ChildProcess } from 'child_process';
import { BaseBackend, type BackendKind } from './backend';

// The echoed command contains `"__VSC" "_DONE__` while the printed result is
// `__VSC_DONE__ <id>`, so the two lines can never be confused.
const SENTINEL_ECHO_RE = /^\.\s+display\s+"__VSC"\s+"_DONE__\s+\d+"\s*$/;
const SENTINEL_OUT_RE = /^__VSC_DONE__ (\d+)\s*$/;
const PARTIAL_FLUSH_MS = 50;

/**
 * Backend that pipes commands into Stata's console binary (`stata-mp -q`).
 * Only available on macOS and Linux — Windows Stata has no console mode.
 *
 * Completion is detected by appending a `display` sentinel after each batch.
 */
export class ConsoleBackend extends BaseBackend {
    readonly kind: BackendKind = 'console';
    readonly label: string;

    private process: ChildProcess | null = null;
    private nextBatchId = 0;
    private partial = '';
    private partialTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly stataPath: string) {
        super();
        this.label = `Stata console — ${stataPath}`;
    }

    start(cwd: string): void {
        if (this.process) {
            return;
        }

        this.process = spawn(this.stataPath, ['-q'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd,
            env: { ...process.env },
        });

        this.process.stdout?.setEncoding('utf8');
        this.process.stdout?.on('data', (data: string) => this.handleStdout(data));

        // Writing after Stata exits raises EPIPE here; `exit` reports the real cause.
        this.process.stdin?.on('error', () => { /* ignore */ });

        this.process.stderr?.setEncoding('utf8');
        this.process.stderr?.on('data', (data: string) => {
            this.fire('stderr', data.replace(/\r\n/g, '\n'));
        });

        this.process.on('exit', (code) => {
            this.flushPartial();
            this.process = null;
            this.fire('exit', code);
        });

        this.process.on('error', (err) => {
            this.process = null;
            this.fire('error', err);
        });

        // The console binary accepts input immediately.
        setImmediate(() => this.fire('ready'));
    }

    execute(commands: string[]): number {
        const id = ++this.nextBatchId;
        const lines = [...commands, `display "__VSC" "_DONE__ ${id}"`];
        this.write(lines.join('\n') + '\n');
        return id;
    }

    private write(payload: string): void {
        if (!this.process?.stdin?.writable) {
            this.fire('error', new Error('Stata process is not running'));
            return;
        }
        this.process.stdin.write(payload);
    }

    private handleStdout(data: string): void {
        if (this.partialTimer) {
            clearTimeout(this.partialTimer);
            this.partialTimer = null;
        }

        const text = this.partial + data.replace(/\r\n/g, '\n');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) {
            this.partial = text;
        } else {
            this.partial = text.slice(lastNewline + 1);
            this.emitLines(text.slice(0, lastNewline + 1));
        }

        // Prompts and `--more--` arrive without a trailing newline; flush them
        // if nothing else follows shortly.
        if (this.partial) {
            this.partialTimer = setTimeout(() => this.flushPartial(), PARTIAL_FLUSH_MS);
        }
    }

    private flushPartial(): void {
        if (this.partialTimer) {
            clearTimeout(this.partialTimer);
            this.partialTimer = null;
        }
        if (this.partial) {
            const pending = this.partial;
            this.partial = '';
            this.emitLines(pending);
        }
    }

    /** Emit text, stripping sentinel lines and firing `done` for each one. */
    private emitLines(text: string): void {
        let buffer = '';
        for (const line of text.split(/(?<=\n)/)) {
            const bare = line.replace(/\n$/, '');
            if (SENTINEL_ECHO_RE.test(bare.trim())) {
                continue;
            }
            const done = bare.trim().match(SENTINEL_OUT_RE);
            if (done) {
                if (buffer) {
                    this.fire('output', buffer);
                    buffer = '';
                }
                this.fire('done', parseInt(done[1], 10));
                continue;
            }
            buffer += line;
        }
        if (buffer) {
            this.fire('output', buffer);
        }
    }

    interrupt(): void {
        this.process?.kill('SIGINT');
    }

    isRunning(): boolean {
        return this.process !== null;
    }

    stop(): void {
        if (!this.process) {
            return;
        }
        if (this.process.stdin?.writable) {
            this.process.stdin.write('exit, clear\n');
        }
        const proc = this.process;
        setTimeout(() => {
            if (this.process === proc) {
                proc.kill('SIGTERM');
            }
        }, 2000);
    }

    dispose(): void {
        if (this.partialTimer) {
            clearTimeout(this.partialTimer);
            this.partialTimer = null;
        }
        if (this.process) {
            this.process.kill('SIGKILL');
            this.process = null;
        }
        this.removeAllListeners();
    }
}
