const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { PyStataBackend } = require('../out/pystataBackend.js');
const { spawnSync } = require('node:child_process');

test('real PyStata streams errors, completes batches, interrupts and exports a graph', {
    skip: process.env.STATA_INTEGRATION !== '1', timeout: 45000,
}, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stata bridge café '));
    const graph = path.join(dir, 'graph.svg');
    const doFile = path.join(dir, 'graph.do');
    const postFile = path.join(dir, 'post.do');
    const stataPath = (file) => file.replace(/\\/g, '/');
    fs.writeFileSync(doFile, `scatter mpg weight\ngraph export "${stataPath(graph)}", replace\n`);
    fs.writeFileSync(postFile, 'file open smoke using "post.marker", write replace\nfile write smoke "post do ran"\nfile close smoke\n');
    const backend = new PyStataBackend({
        pythonPath: process.env.STATA_PYTHON || (process.platform === 'darwin' ? '/opt/homebrew/bin/python3' : 'python3'),
        stataDir: process.env.STATA_INSTALL_DIR || '/Applications/StataNow',
        edition: process.env.STATA_EDITION || 'mp',
    });
    t.after(() => {
        backend.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    let output = '';
    const done = [];
    const errors = [];
    const log = [];
    backend.on('output', (text) => { output += text; log.push(text); });
    backend.on('stderr', (text) => log.push(`STDERR ${text}`));
    backend.on('ready', () => log.push('[ready]\n'));
    backend.on('done', (id) => { done.push(id); log.push(`[done ${id}]\n`); });
    backend.on('error', (err) => errors.push(err.message));
    async function waitDone(id) {
        while (!done.includes(id)) {
            await once(backend, 'done');
        }
    }
    const ready = once(backend, 'ready');
    backend.start(dir);
    const first = backend.execute(['sysuse auto, clear', 'regress price nosuchvar', 'summarize mpg']);
    const second = backend.execute(['display 1+1']);
    await ready;
    await waitDone(second);
    assert.deepEqual(done, [first, second]);
    assert.match(output, /nosuchvar/);
    assert.match(output, /r\(111\);/);
    assert.match(output, /summarize mpg[\s\S]*21\.2973/);
    assert.match(output, /display 1\+1\n2/);
    assert.doesNotMatch(output, /STATA_BRIDGE/);

    const started = Date.now();
    const sleeping = backend.execute(['sleep 20000']);
    while (!output.includes('. sleep 20000')) {
        await once(backend, 'output');
    }
    assert.ok(!done.includes(sleeping), 'sleep output must stream before completion');
    backend.interrupt();
    await waitDone(sleeping);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `interrupt took ${elapsed}ms`);
    log.push(`[interrupt completed in ${elapsed}ms]\n`);

    const graphBatch = backend.execute([`do "${stataPath(doFile)}"`, `run "${stataPath(postFile)}"`]);
    await waitDone(graphBatch);
    assert.match(fs.readFileSync(graph, 'utf8'), /<svg/);
    assert.equal(fs.readFileSync(path.join(dir, 'post.marker'), 'utf8'), 'post do ran');
    log.push('[graph export verified]\n');
    const exit = once(backend, 'exit');
    backend.stop();
    const [code] = await exit;
    assert.equal(code, 0);
    assert.equal(backend.isRunning(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(done, [first, second, sleeping, graphBatch]);
    log.push(`[exit ${code}]\n`);
    console.log(log.join(''));
});

test('real bridge rejects nested prompts without consuming protocol input', {
    skip: process.env.STATA_INTEGRATION !== '1', timeout: 15000,
}, () => {
    const result = spawnSync(
        process.env.STATA_PYTHON || (process.platform === 'darwin' ? '/opt/homebrew/bin/python3' : 'python3'),
        ['-u', path.join(__dirname, '..', 'python', 'stata_bridge.py'), '--stata-dir', process.env.STATA_INSTALL_DIR || '/Applications/StataNow', '--edition', process.env.STATA_EDITION || 'mp'],
        {
            encoding: 'utf8', timeout: 10000, windowsHide: true,
            input: JSON.stringify({ type: 'run', id: 1, commands: ['mata', 'python:', 'display 99'] }) + '\n',
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Interactive Mata\/Python prompts/);
    assert.match(result.stdout, /display 99\r?\n99/);
    assert.match(result.stdout, /"type": "done", "id": 1/);
});
