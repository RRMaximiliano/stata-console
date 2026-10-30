import { EventEmitter } from 'events';

/**
 * Backend contract between the console UI (StataTerminal) and whatever
 * actually runs Stata.
 *
 *  - `console`: spawns the Stata console binary (`stata-mp -q`) with piped
 *    stdin/stdout. macOS and Linux only.
 *  - `pystata`: spawns Python running `python/stata_bridge.py`, which drives
 *    Stata through PyStata (Stata 17+). Works on Windows, macOS, and Linux.
 *
 * This module has no `vscode` dependency so it can be unit-tested with node.
 */
export type BackendKind = 'console' | 'pystata';

export interface StataBackendEvents {
    /** Stata output. Line endings normalized to `\n`. Internal sentinels already removed. */
    output: [text: string];
    /** Diagnostic text from the backend process itself (not Stata results). */
    stderr: [text: string];
    /** The batch with this id has finished (even if a command in it errored). */
    done: [batchId: number];
    /** The backend is initialized and accepting batches (PyStata init can take seconds). */
    ready: [];
    /** The underlying process exited. */
    exit: [code: number | null];
    error: [err: Error];
}

export interface StataBackend {
    readonly kind: BackendKind;
    /** Human-readable description, e.g. "Stata console — /usr/local/bin/stata-mp". */
    readonly label: string;

    /** Spawn the process. `cwd` becomes Stata's initial working directory. */
    start(cwd: string): void;

    /**
     * Queue a batch of single-line Stata commands, executed in order.
     * Returns a batch id; `done` fires with that id once the whole batch has run.
     * Batches submitted before `ready` are queued and run afterwards.
     */
    execute(commands: string[]): number;

    /** Request a Stata `--Break--` of the currently running command. */
    interrupt(): void;
    isRunning(): boolean;
    /** Graceful shutdown (`exit, clear`), escalating to kill after a timeout. */
    stop(): void;
    /** Immediate kill and listener cleanup. */
    dispose(): void;

    on<E extends keyof StataBackendEvents>(event: E, listener: (...args: StataBackendEvents[E]) => void): this;
    off<E extends keyof StataBackendEvents>(event: E, listener: (...args: StataBackendEvents[E]) => void): this;
}

/** Typed EventEmitter base for backend implementations. */
export abstract class BaseBackend extends EventEmitter implements StataBackend {
    abstract readonly kind: BackendKind;
    abstract readonly label: string;
    abstract start(cwd: string): void;
    abstract execute(commands: string[]): number;
    abstract interrupt(): void;
    abstract isRunning(): boolean;
    abstract stop(): void;
    abstract dispose(): void;

    override on<E extends keyof StataBackendEvents>(event: E, listener: (...args: StataBackendEvents[E]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    override off<E extends keyof StataBackendEvents>(event: E, listener: (...args: StataBackendEvents[E]) => void): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }

    protected fire<E extends keyof StataBackendEvents>(event: E, ...args: StataBackendEvents[E]): void {
        this.emit(event, ...args);
    }
}

/**
 * Convert a filesystem path to a form that is safe inside a double-quoted
 * Stata string on every platform. Stata on Windows accepts forward slashes,
 * and backslashes are dangerous there because `\` escapes a following
 * backtick or `$` (e.g. `C:\Users\$name`).
 */
export function toStataPath(fsPath: string): string {
    return fsPath.replace(/\\/g, '/');
}
