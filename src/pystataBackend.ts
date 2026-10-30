import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { BaseBackend } from './backend';
import type { StataEdition } from './stataPathResolver';

type BridgeMessage = { type: 'ready' } | { type: 'done'; id: number }
    | { type: 'error' | 'init_error'; message: string };

/** Incremental parser; ordinary output streams even without a trailing newline. */
export class PyStataStreamParser {
    private pending = '';
    private previousCR = false;
    private readonly marker: string;

    constructor(
        private readonly output: (text: string) => void,
        private readonly control: (message: BridgeMessage) => void,
        private readonly error: (error: Error) => void,
        token = '',
    ) {
        this.marker = `\x1eSTATA_BRIDGE:${token}:`;
    }

    push(chunk: string): void {
        if (chunk.length === 0) {
            return;
        }
        const previousCR = this.previousCR;
        this.previousCR = chunk.endsWith('\r');
        if (previousCR && chunk.startsWith('\n')) {
            chunk = chunk.slice(1);
        }
        this.pending += chunk.replace(/\r\n?/g, '\n');
        while (this.pending) {
            const start = this.pending.indexOf(this.marker);
            if (start < 0) {
                let keep = Math.min(this.pending.length, this.marker.length - 1);
                while (keep > 0 && !this.pending.endsWith(this.marker.slice(0, keep))) {
                    keep--;
                }
                const text = this.pending.slice(0, this.pending.length - keep);
                this.pending = this.pending.slice(this.pending.length - keep);
                if (text) {
                    this.output(text);
                }
                return;
            }
            if (start > 0) {
                const text = this.pending.slice(0, start);
                this.pending = this.pending.slice(start);
                this.output(text);
            }
            const end = this.pending.indexOf('\n', this.marker.length);
            if (end < 0) {
                return;
            }
            const record = this.pending.slice(this.marker.length, end);
            this.pending = this.pending.slice(end + 1);
            let message: BridgeMessage;
            try {
                message = JSON.parse(record) as BridgeMessage;
                if (!message || (message.type !== 'ready'
                    && !(message.type === 'done' && Number.isSafeInteger(message.id))
                    && !((message.type === 'error' || message.type === 'init_error') && typeof message.message === 'string'))) {
                    throw new Error('Unknown bridge control message');
                }
            } catch (err) {
                this.error(new Error(`Invalid PyStata control message: ${String(err)}`));
                continue;
            }
            this.control(message);
        }
    }

    finish(): void {
        if (this.pending && (this.pending.startsWith(this.marker) || this.marker.startsWith(this.pending))) {
            this.error(new Error('PyStata exited with an incomplete control message'));
        } else if (this.pending) {
            this.output(this.pending);
        }
        this.pending = '';
        this.previousCR = false;
    }
}

export interface PyStataBackendOptions {
    pythonPath: string;
    pythonArgs?: string[];
    stataDir: string;
    edition: StataEdition;
    bridgePath?: string;
}

export class PyStataBackend extends BaseBackend {
    readonly kind = 'pystata' as const;
    readonly label: string;
    private process: ChildProcess | null = null;
    private nextBatchId = 0;
    private ready = false;
    private stopping = false;
    private startupFailed = false;
    private disposed = false;
    private pending: { type: 'run'; id: number; commands: string[] }[] = [];
    private stopTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: PyStataBackendOptions) {
        super();
        this.label = `Stata PyStata — ${options.stataDir} (${options.pythonPath})`;
    }

    start(cwd: string): void {
        if (this.process || this.disposed) {
            return;
        }
        this.ready = false;
        this.stopping = false;
        this.startupFailed = false;
        const token = randomBytes(16).toString('hex');
        const parser = new PyStataStreamParser(
            (text) => {
                if (!this.disposed) {
                    this.fire('output', text);
                }
            },
            (message) => this.handleControl(message),
            (err) => {
                if (!this.disposed) {
                    this.fire('error', err);
                }
            },
            token,
        );
        const proc = spawn(this.options.pythonPath, [
            ...(this.options.pythonArgs ?? []), '-u',
            this.options.bridgePath ?? path.join(__dirname, '..', 'python', 'stata_bridge.py'),
            '--stata-dir', this.options.stataDir, '--edition', this.options.edition, '--token', token,
        ], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        });
        this.process = proc;
        proc.stdout?.setEncoding('utf8');
        proc.stdout?.on('data', (chunk: string) => parser.push(chunk));
        proc.stderr?.setEncoding('utf8');
        proc.stderr?.on('data', (chunk: string) => {
            if (!this.disposed) {
                this.fire('stderr', chunk.replace(/\r\n?/g, '\n'));
            }
        });
        proc.stdin?.on('error', (err) => {
            if (!this.stopping && !this.startupFailed) {
                this.fire('error', err);
            }
        });
        proc.on('error', (err) => {
            if (this.disposed) {
                return;
            }
            this.startupFailed = true;
            this.fire('error', new Error(`Could not start Python (${this.options.pythonPath}): ${err.message}. Set stata.pythonPath to Python 3.8+.`));
        });
        // close follows stdout/stderr draining; exit can precede the final done.
        proc.on('close', (code) => {
            if (this.disposed) {
                return;
            }
            parser.finish();
            clearTimeout(this.stopTimer);
            this.stopTimer = undefined;
            this.process = null;
            this.pending = [];
            if (!this.ready && !this.startupFailed && !this.stopping) {
                this.fire('error', new Error(`Python exited before PyStata became ready (code ${code}). Check the Stata Console output and stata.pythonPath/installDir settings.`));
            }
            this.ready = false;
            this.fire('exit', code);
        });
    }

    execute(commands: string[]): number {
        const id = ++this.nextBatchId;
        if (this.stopping || this.startupFailed) {
            this.fire('error', new Error('PyStata is stopping or failed to initialize. Restart the Stata console.'));
        } else if (commands.some((command) => /[\r\n]/.test(command))) {
            this.fire('error', new Error('PyStata batches require single-line Stata commands. Use a do-file for multiple lines.'));
        } else {
            this.pending.push({ type: 'run', id, commands: [...commands] });
            this.flushPending();
        }
        return id;
    }

    private handleControl(message: BridgeMessage): void {
        if (this.disposed) {
            return;
        }
        if (message.type === 'ready') {
            if (this.stopping) {
                return;
            }
            this.ready = true;
            this.flushPending();
            this.fire('ready');
        } else if (message.type === 'done') {
            this.fire('done', message.id);
        } else {
            if (message.type === 'init_error') {
                this.startupFailed = true;
                this.pending = [];
            }
            this.fire('error', new Error(message.message));
        }
    }

    private flushPending(): void {
        if (this.ready && !this.stopping) {
            for (const request of this.pending.splice(0)) {
                this.write(request);
            }
        }
    }

    private write(message: object): void {
        if (!this.process?.stdin?.writable) {
            this.fire('error', new Error('PyStata process is not running'));
            return;
        }
        this.process.stdin.write(JSON.stringify(message) + '\n');
    }

    interrupt(): void {
        if (this.ready && !this.stopping) {
            this.write({ type: 'break' });
        }
    }

    isRunning(): boolean {
        return this.process !== null;
    }

    stop(): void {
        const proc = this.process;
        if (!proc || this.stopping) {
            return;
        }
        this.stopping = true;
        this.pending = [];
        this.write({ type: 'stop' });
        this.stopTimer = setTimeout(() => {
            if (this.process === proc) {
                proc.kill('SIGKILL');
            }
        }, 2000);
        this.stopTimer.unref();
    }

    dispose(): void {
        this.disposed = true;
        this.stopping = true;
        this.pending = [];
        clearTimeout(this.stopTimer);
        this.process?.kill('SIGKILL');
        this.process = null;
        this.removeAllListeners();
    }
}
