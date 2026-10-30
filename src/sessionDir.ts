import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Per-session temp directories (`stata-vsc-*`). Each holds a `session.lock`
 * containing the owning process id so that one VS Code window never deletes
 * another window's live session. No `vscode` dependency.
 */
export const SESSION_PREFIX = 'stata-vsc-';
export const LOCK_FILE = 'session.lock';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but belongs to someone else
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function createSessionDir(base = os.tmpdir(), pid = process.pid): string {
    const dir = fs.mkdtempSync(path.join(base, SESSION_PREFIX));
    fs.writeFileSync(path.join(dir, LOCK_FILE), String(pid), 'utf-8');
    return dir;
}

function isStale(dir: string, now: number, alive: (pid: number) => boolean): boolean {
    try {
        const pid = parseInt(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
            return !alive(pid);
        }
    } catch { /* no lock file: dir from an older version */ }
    try {
        return now - fs.statSync(dir).mtimeMs > STALE_AFTER_MS;
    } catch {
        return false;
    }
}

/** Remove session dirs whose owner is gone (or, without a lock, older than 24h). */
export function cleanupStaleSessions(
    base = os.tmpdir(),
    now = Date.now(),
    alive: (pid: number) => boolean = isProcessAlive,
): string[] {
    const removed: string[] = [];
    let entries: string[];
    try {
        entries = fs.readdirSync(base);
    } catch {
        return removed;
    }
    for (const entry of entries) {
        if (!entry.startsWith(SESSION_PREFIX)) { continue; }
        const dir = path.join(base, entry);
        if (!isStale(dir, now, alive)) { continue; }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            removed.push(dir);
        } catch { /* skip */ }
    }
    return removed;
}

export function removeSessionDir(dir: string): void {
    // Drop the lock first: if removal fails (Windows keeps files open briefly
    // after the process is killed), the next cleanup sees a dead session.
    try { fs.unlinkSync(path.join(dir, LOCK_FILE)); } catch { /* ignore */ }
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore */ }
}
