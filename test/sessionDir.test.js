const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LOCK_FILE, cleanupStaleSessions, createSessionDir, isProcessAlive } = require('../out/sessionDir.js');

function makeBase() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'stata-session-test-'));
}

test('a new session dir records its owner pid', () => {
    const base = makeBase();
    const dir = createSessionDir(base, 4242);
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8'), '4242');
    fs.rmSync(base, { recursive: true, force: true });
});

test('cleanup keeps sessions of live processes and removes those of dead ones', () => {
    const base = makeBase();
    const live = createSessionDir(base, 111);
    const dead = createSessionDir(base, 222);
    fs.writeFileSync(path.join(dead, '_graph.png'), 'x');
    const removed = cleanupStaleSessions(base, Date.now(), (pid) => pid === 111);
    assert.deepEqual(removed, [dead]);
    assert.ok(fs.existsSync(live));
    assert.ok(!fs.existsSync(dead));
    fs.rmSync(base, { recursive: true, force: true });
});

test('dirs without a lock are only removed once they are over 24 hours old', () => {
    const base = makeBase();
    const legacy = path.join(base, 'stata-vsc-legacy');
    fs.mkdirSync(legacy);
    assert.deepEqual(cleanupStaleSessions(base, Date.now(), () => false), []);
    assert.ok(fs.existsSync(legacy));
    assert.deepEqual(cleanupStaleSessions(base, Date.now() + 25 * 3600 * 1000, () => false), [legacy]);
    fs.rmSync(base, { recursive: true, force: true });
});

test('unrelated directories are never touched', () => {
    const base = makeBase();
    const other = path.join(base, 'something-else');
    fs.mkdirSync(other);
    cleanupStaleSessions(base, Date.now() + 99 * 3600 * 1000, () => false);
    assert.ok(fs.existsSync(other));
    fs.rmSync(base, { recursive: true, force: true });
});

test('isProcessAlive detects this process and a nonexistent one', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(2 ** 22 - 3), false);
});
