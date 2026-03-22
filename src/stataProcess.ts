import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';

export class StataProcess extends EventEmitter {
    private process: ChildProcess | null = null;
    private stataPath: string;

    constructor(stataPath: string) {
        super();
        this.stataPath = stataPath;
    }

    start(cwd?: string): void {
        if (this.process) {
            return;
        }

        this.process = spawn(this.stataPath, ['-q'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: cwd || os.homedir(),
            env: { ...process.env },
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            this.emit('output', data.toString());
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            this.emit('stderr', data.toString());
        });

        this.process.on('exit', (code) => {
            this.process = null;
            this.emit('exit', code);
        });

        this.process.on('error', (err) => {
            this.process = null;
            this.emit('error', err);
        });
    }

    /**
     * Write raw text to Stata's stdin. Handles single or multi-line input.
     * Stata reads line-by-line from stdin and executes sequentially.
     */
    write(text: string): void {
        if (!this.process?.stdin?.writable) {
            this.emit('error', new Error('Stata process is not running'));
            return;
        }
        // Ensure text ends with newline so Stata processes the last line
        const payload = text.endsWith('\n') ? text : text + '\n';
        this.process.stdin.write(payload);
    }

    interrupt(): void {
        if (this.process) {
            this.process.kill('SIGINT');
        }
    }

    isRunning(): boolean {
        return this.process !== null;
    }

    stop(): void {
        if (this.process) {
            this.write('exit, clear');
            setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGTERM');
                    this.process = null;
                }
            }, 2000);
        }
    }

    dispose(): void {
        if (this.process) {
            this.process.kill('SIGKILL');
            this.process = null;
        }
        this.removeAllListeners();
    }
}
