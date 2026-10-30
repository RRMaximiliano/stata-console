const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const { PyStataStreamParser } = require('../out/pystataBackend.js');

function parse(chunks, token = '') {
    const events = [];
    const parser = new PyStataStreamParser(
        (text) => events.push(['output', text]),
        (message) => events.push([message.type, message.id ?? message.message]),
        (err) => events.push(['error', err.message]),
        token,
    );
    for (const chunk of chunks) {
        parser.push(chunk);
    }
    parser.finish();
    return events;
}

test('parser preserves output and control ordering for every split boundary', () => {
    const transcript = '\x1eSTATA_BRIDGE:token:{"type":"ready"}\r\n. display "café"\r\ncafé\r\n'
        + '\x1eSTATA_BRIDGE:token:{"type":"done","id":1}\r\nnext\n'
        + '\x1eSTATA_BRIDGE:token:{"type":"done","id":2}\n';
    for (let split = 0; split <= transcript.length; split++) {
        const events = parse([transcript.slice(0, split), transcript.slice(split)], 'token');
        let text = '';
        const controls = [];
        for (const [type, value] of events) {
            if (type === 'output') {
                text += value;
            } else {
                assert.notEqual(type, 'error');
                controls.push([type, value, text]);
            }
        }
        assert.deepEqual(controls, [
            ['ready', undefined, ''],
            ['done', 1, '. display "café"\ncafé\n'],
            ['done', 2, '. display "café"\ncafé\nnext\n'],
        ], `split ${split}`);
    }
});

test('parser streams partial lines and handles byte-sized chunks and split CRLF', () => {
    assert.deepEqual(parse(['prompt', '\r', '\n', '\n', 'tail']), [
        ['output', 'prompt'], ['output', '\n'], ['output', '\n'], ['output', 'tail'],
    ]);
    const events = parse(Array.from('a\n\x1eSTATA_BRIDGE::{"type":"done","id":42}\n'));
    assert.equal(events.filter(([type]) => type === 'output').map(([, value]) => value).join(''), 'a\n');
    assert.deepEqual(events.at(-1), ['done', 42]);
});

test('parser handles errors, rejects malformed controls, and reports truncated records', () => {
    assert.deepEqual(parse(['\x1eSTATA_BRIDGE::{"type":"init_error","message":"license missing"}\n']), [['init_error', 'license missing']]);
    for (const record of ['garbage', '{}', '{"type":"done","id":"1"}', '{"type":"error"}']) {
        const events = parse([`\x1eSTATA_BRIDGE::${record}\n`]);
        assert.match(events[0][1], /Invalid PyStata control/);
    }
    assert.match(parse(['\x1eSTATA_BRIDGE::{"type":'])[0][1], /incomplete control/);
    assert.match(parse(['\x1eSTATA_B'])[0][1], /incomplete control/);
    assert.equal(parse(['\x1eSTATA_BRIDGE:other:{"type":"ready"}\n'], 'token').map(([, text]) => text).join(''), '\x1eSTATA_BRIDGE:other:{"type":"ready"}\n');
});

function fakeBackend() {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const writes = [];
    const kills = [];
    let spawnArgs;
    proc.stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())));
    proc.kill = (signal) => { kills.push(signal); return true; };
    const modulePath = require.resolve('../out/pystataBackend.js');
    delete require.cache[modulePath];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'child_process') {
            return { spawn: (...args) => { spawnArgs = args; return proc; } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let Backend;
    try {
        Backend = require(modulePath).PyStataBackend;
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
    const backend = new Backend({ pythonPath: 'C:\\Python 3\\python.exe', stataDir: 'C:\\Program Files\\Stata19', edition: 'mp' });
    const errors = [];
    backend.on('error', (err) => errors.push(err.message));
    return {
        backend, proc, writes, kills, errors,
        get spawnArgs() { return spawnArgs; },
        control(message) {
            const args = spawnArgs[1];
            const token = args[args.indexOf('--token') + 1];
            proc.stdout.write(`\x1eSTATA_BRIDGE:${token}:${JSON.stringify(message)}\r\n`);
        },
    };
}

test('backend queues batches before ready and spawns executable and arguments without shell quoting', () => {
    const fake = fakeBackend();
    const { backend, writes } = fake;
    assert.equal(backend.execute(['display "one"']), 1);
    backend.start('/tmp');
    assert.equal(backend.execute(['do "C:/with spaces/run.do"', 'run "C:/post.do"']), 2);
    assert.deepEqual(writes, []);
    fake.control({ type: 'ready' });
    assert.deepEqual(writes.map(({ id }) => id), [1, 2]);
    assert.equal(writes[1].commands[0], 'do "C:/with spaces/run.do"');
    assert.equal(fake.spawnArgs[0], 'C:\\Python 3\\python.exe');
    assert.equal(fake.spawnArgs[1][0], '-u');
    assert.ok(fake.spawnArgs[1].includes('C:\\Program Files\\Stata19'));
    assert.equal(fake.spawnArgs[2].windowsHide, true);
    assert.equal(fake.spawnArgs[2].env.PYTHONUNBUFFERED, '1');
    assert.equal(fake.spawnArgs[2].env.PYTHONIOENCODING, 'utf-8');
    assert.equal(fake.spawnArgs[2].shell, undefined);
    backend.dispose();
    assert.equal(backend.isRunning(), false);
});

test('backend sends break and graceful stop messages without SIGINT', () => {
    const fake = fakeBackend();
    fake.backend.start('/tmp');
    fake.control({ type: 'ready' });
    fake.backend.interrupt();
    fake.backend.stop();
    fake.backend.stop();
    assert.deepEqual(fake.writes, [{ type: 'break' }, { type: 'stop' }]);
    assert.deepEqual(fake.kills, []);
    let exitCode;
    fake.backend.on('exit', (code) => { exitCode = code; });
    fake.proc.emit('close', 0);
    assert.equal(exitCode, 0);
    assert.equal(fake.backend.isRunning(), false);
});

test('backend forwards Stata output, ordered completion, stderr and initialization errors', () => {
    const fake = fakeBackend();
    const events = [];
    fake.backend.on('output', (text) => events.push(['output', text]));
    fake.backend.on('done', (id) => events.push(['done', id]));
    fake.backend.on('stderr', (text) => events.push(['stderr', text]));
    fake.backend.start('/tmp');
    fake.control({ type: 'ready' });
    fake.proc.stdout.write('no such variable\r\nr(111);\r\n');
    fake.control({ type: 'done', id: 1 });
    fake.proc.stderr.write('diagnostic\r\n');
    assert.deepEqual(events, [['output', 'no such variable\nr(111);\n'], ['done', 1], ['stderr', 'diagnostic\n']]);
    fake.backend.dispose();
    fake.proc.emit('error', new Error('late spawn error'));

    const failed = fakeBackend();
    failed.backend.start('/tmp');
    failed.backend.execute(['display 1']);
    failed.control({ type: 'init_error', message: 'Check the Stata license' });
    failed.proc.emit('close', 1);
    assert.deepEqual(failed.errors, ['Check the Stata license']);
    assert.deepEqual(failed.writes, []);
});

test('backend reports spawn failure once and suppresses ready during shutdown', () => {
    const failed = fakeBackend();
    failed.backend.start('/tmp');
    failed.proc.emit('error', new Error('ENOENT'));
    failed.proc.emit('close', -2);
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /Could not start Python.*stata\.pythonPath/);

    const stopping = fakeBackend();
    let ready = false;
    stopping.backend.on('ready', () => { ready = true; });
    stopping.backend.execute(['display 1']);
    stopping.backend.start('/tmp');
    stopping.backend.stop();
    stopping.control({ type: 'ready' });
    assert.equal(ready, false);
    assert.deepEqual(stopping.writes, [{ type: 'stop' }]);
    stopping.proc.emit('close', 0);
    assert.deepEqual(stopping.errors, []);
});
