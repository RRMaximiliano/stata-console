const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./helpers/fakeVscode.js').install();
const { BaseBackend } = require('../out/backend.js');
const { StataTerminal } = require('../out/stataTerminal.js');

class FakeBackend extends BaseBackend {
    kind = 'console';
    label = 'fake';
    batches = [];
    running = true;
    interrupts = 0;
    doneSynchronously = false;
    start() { this.started = true; }
    execute(commands) {
        const id = this.batches.length + 1;
        this.batches.push(commands);
        if (this.doneSynchronously) { this.fire('done', id); }
        return id;
    }
    interrupt() { this.interrupts++; }
    isRunning() { return this.running; }
    stop() { /* not needed */ }
    dispose() { this.running = false; this.disposed = true; }
}

const created = [];
afterEach(() => {
    for (const term of created.splice(0)) { term.dispose(); }
});

function setup({ open = true } = {}) {
    const backend = new FakeBackend();
    const term = new StataTerminal(backend);
    created.push(term);
    const state = { text: '', busy: [], errors: [], graphs: [], browses: [], vars: 0, closed: 0, results: 0 };
    term.onDidWrite((s) => { state.text += s; });
    term.onDidChangeBusy((b) => state.busy.push(b));
    term.onDidDetectError((e) => state.errors.push(e));
    term.onDidDetectGraph((g) => state.graphs.push(path.basename(g)));
    term.onDidRequestBrowse((b) => state.browses.push(b));
    term.onDidUpdateVariables(() => state.vars++);
    term.onDidUpdateResults(() => state.results++);
    term.onDidClose(() => state.closed++);
    if (open) { term.open(); }
    const plain = () => state.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    return { backend, term, state, plain };
}

const done = (backend, id) => backend.fire('done', id);
const type = (term, text) => term.handleInput(text);

test('banner shows the real shortcut for running a line', () => {
    const { term, plain } = setup();
    assert.ok(plain().includes('Shift+Enter'));
    assert.ok(plain().includes(process.platform === 'darwin' ? '\u2318\u21A9' : 'Ctrl+Enter'));
    term.dispose();
});

test('a typed line runs once, followed by the silent post-run export', () => {
    const { backend, term, state } = setup();
    backend.fire('ready');
    type(term, 'summarize price\r');
    assert.equal(backend.batches.length, 1);
    assert.equal(backend.batches[0][0], 'summarize price');
    assert.match(backend.batches[0][1], /^run `".*_post\.do"'$/);
    assert.deepEqual(state.busy, [true]);
    done(backend, 1);
    assert.deepEqual(state.busy, [true, false]);
    assert.equal(state.vars, 1);
    assert.equal(state.results, 1);
    term.dispose();
});

test('typing a brace block shows continuation prompts and runs it as one do-file', () => {
    const { backend, term, plain } = setup();
    type(term, 'forvalues i = 1/3 {\r');
    type(term, '  display `i\'\r');
    assert.equal(backend.batches.length, 0);
    assert.ok(plain().includes('  2. '));
    assert.ok(plain().includes('  3. '));
    type(term, '}\r');
    assert.equal(backend.batches.length, 1);
    const m = backend.batches[0][0].match(/^do `"(.*)"'$/);
    assert.ok(m, backend.batches[0][0]);
    assert.equal(fs.readFileSync(m[1], 'utf-8'), 'forvalues i = 1/3 {\n  display `i\'\n}\n');
    done(backend, 1);
    assert.ok(!fs.existsSync(m[1]), 'temp do-file is removed after the batch');
    term.dispose();
});

test('no raw lone brace line is ever sent to the backend', () => {
    const { backend, term } = setup();
    type(term, 'if 1 {\r');
    type(term, 'display 1\r');
    type(term, '}\r');
    for (const batch of backend.batches) {
        for (const cmd of batch) { assert.notEqual(cmd.trim(), '{'); assert.notEqual(cmd.trim(), 'if 1 {'); }
    }
    term.dispose();
});

test('pasting several lines at once runs each complete statement in order', () => {
    const { backend, term } = setup();
    type(term, 'display 1\r\nforvalues i = 1/2 {\r\n  display `i\'\r\n}\r\ndisplay 2\r\n');
    assert.equal(backend.batches.length, 3);
    assert.equal(backend.batches[0][0], 'display 1');
    assert.match(backend.batches[1][0], /^do /);
    assert.equal(backend.batches[2][0], 'display 2');
    term.dispose();
});

test('both DEL and BS erase, and arrow keys edit mid-line', () => {
    const { backend, term } = setup();
    type(term, 'abcX');
    type(term, '\x7f');
    type(term, 'Y');
    type(term, '\b');
    type(term, '\r');
    assert.equal(backend.batches[0][0], 'abc');
    type(term, 'sumarize price');
    type(term, '\x1b[H');
    type(term, '\x1b[C'.repeat(3));
    type(term, 'm\r');
    assert.equal(backend.batches[1][0], 'summarize price');
});

test('Home/End/Ctrl+A/E move the cursor', () => {
    const { backend, term } = setup();
    type(term, 'price');
    type(term, '\x01');
    type(term, 'summarize ');
    type(term, '\x05');
    type(term, ', detail\r');
    assert.equal(backend.batches[0][0], 'summarize price, detail');
    term.dispose();
});

test('Enter while busy queues the command; the prompt returns only after everything finished', () => {
    const { backend, term, state, plain } = setup();
    type(term, 'sleep 1000\r');
    type(term, 'display 2\r');
    assert.equal(backend.batches.length, 2);
    const promptsBefore = (plain().match(/\. $/gm) || []).length;
    done(backend, 1);
    assert.deepEqual(state.busy, [true], 'still busy: second batch pending');
    assert.equal((plain().match(/\. $/gm) || []).length, promptsBefore);
    done(backend, 2);
    assert.deepEqual(state.busy, [true, false]);
    assert.ok(plain().endsWith('. '));
    term.dispose();
});

test('Run commands issued while busy queue behind the running one', () => {
    const { backend, term, state } = setup();
    term.sendCode('display 1', undefined, { uri: 'a', line: 0, from: 0, to: 0 });
    term.sendCode('display 2', undefined, { uri: 'b', line: 5, from: 5, to: 5 });
    assert.equal(backend.batches.length, 2);
    assert.deepEqual(state.busy, [true]);
    // An error printed while the first batch runs belongs to the first target.
    backend.fire('output', 'variable x not found\nr(111);\n');
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].target.uri, 'a');
    done(backend, 1);
    backend.fire('output', 'variable y not found\nr(111);\n');
    assert.equal(state.errors[1].target.uri, 'b');
    done(backend, 2);
    assert.deepEqual(state.busy, [true, false]);
    term.dispose();
});

test('code sent before the terminal opens is kept in order (nothing is overwritten)', () => {
    const { backend, term } = setup({ open: false });
    term.sendCode('display 1');
    term.sendCode('display 2');
    term.sendCode('display 3');
    assert.equal(backend.batches.length, 0);
    term.open();
    assert.equal(backend.batches.length, 3);
    const files = backend.batches.map((b) => b.find((c) => c.startsWith('do ')).match(/`"(.*)"'/)[1]);
    assert.deepEqual(files.map((f) => fs.readFileSync(f, 'utf-8').trim()), ['display 1', 'display 2', 'display 3']);
    term.dispose();
});

test('a backend that completes a batch before execute returns does not leave the terminal busy', () => {
    const { backend, term, state } = setup();
    backend.doneSynchronously = true;
    type(term, 'display 1\r');
    assert.equal(state.busy.at(-1) === true, false, 'busy must not stay true');
    term.dispose();
});

test('closing the terminal mid-run clears busy and removes the temp dir', () => {
    const { backend, term, state } = setup();
    term.sendCode('sleep 100000');
    assert.deepEqual(state.busy, [true]);
    const dir = term.tempDir;
    term.close();
    assert.deepEqual(state.busy, [true, false]);
    assert.equal(backend.disposed, true);
    assert.ok(!fs.existsSync(dir));
    // late events from the dead backend are ignored
    assert.doesNotThrow(() => { term.handleInput('x\r'); term.sendCode('display 1'); });
    term.dispose();
    assert.deepEqual(state.busy, [true, false]);
});

test('disposing twice is harmless', () => {
    const { term } = setup();
    term.dispose();
    assert.doesNotThrow(() => term.dispose());
});

test('Stata exiting mid-run clears busy and closes the terminal', () => {
    const { backend, term, state } = setup();
    term.sendCode('exit, clear');
    backend.fire('exit', 0);
    assert.deepEqual(state.busy, [true, false]);
    assert.equal(state.closed, 1);
    term.dispose();
});

test('a backend that cannot run abandons the batch instead of sticking busy', () => {
    const { backend, term, state, plain } = setup();
    backend.running = false;
    const execute = backend.execute.bind(backend);
    backend.execute = (commands) => { backend.fire('error', new Error('Stata process is not running')); return execute(commands); };
    type(term, 'display 1\r');
    assert.ok(!state.busy.includes(true) || state.busy.at(-1) === false);
    assert.ok(plain().includes('Stata process is not running'));
    term.dispose();
});

test('Ctrl+C interrupts, abandons a half-typed block, and returns to the prompt when idle', () => {
    const { backend, term, plain } = setup();
    type(term, 'forvalues i = 1/3 {\r');
    type(term, '\x03');
    assert.equal(backend.interrupts, 1);
    assert.ok(plain().includes('^C'));
    type(term, 'display 1\r');
    assert.equal(backend.batches[0][0], 'display 1', 'the abandoned block does not swallow the next command');
    term.dispose();
});

test('#delimit typed interactively is rejected without sending anything', () => {
    const { backend, term, plain } = setup();
    type(term, '#delimit ;\r');
    assert.equal(backend.batches.length, 0);
    assert.ok(plain().includes('#delimit can only be used in do-files'));
    term.dispose();
});

test('browse typed interactively exports a bounded CSV and reports the total', () => {
    const { backend, term, state } = setup();
    type(term, 'browse price mpg if foreign\r');
    assert.equal(backend.batches.length, 1);
    const cmd = backend.batches[0][0];
    assert.match(cmd, /^quietly run `".*_browse\.do"' 10000 _browse_i1 `"price mpg if foreign"'$/);
    fs.writeFileSync(path.join(term.tempDir, '_browse_i1.csv'), 'price,mpg\n1,2\n');
    fs.writeFileSync(path.join(term.tempDir, '_browse_i1.count'), '123456\n');
    done(backend, 1);
    assert.equal(state.browses.length, 1);
    assert.equal(state.browses[0].totalObs, 123456);
    assert.ok(state.browses[0].csvPath.endsWith('_browse_i1.csv'));
    term.dispose();
});

test('browse with no data reports empty; a failed browse reports nothing', () => {
    const { backend, term, state } = setup();
    type(term, 'browse\r');
    fs.writeFileSync(path.join(term.tempDir, '_browse_i1.count'), '0\n');
    done(backend, 1);
    assert.deepEqual(state.browses, [{ csvPath: '', totalObs: 0 }]);
    type(term, 'browse nosuchvar\r');
    done(backend, 2);
    assert.equal(state.browses.length, 1);
    term.dispose();
});

test('plots from a run: inline captures in order, then the fallback unless it repeats the last capture', () => {
    const { backend, term, state } = setup();
    const png = Buffer.alloc(300, 1);
    const other = Buffer.alloc(300, 2);
    term.sendCode('scatter y x\nhistogram x');
    fs.writeFileSync(path.join(term.tempDir, '_cap_1_2.png'), png);
    fs.writeFileSync(path.join(term.tempDir, '_cap_1_1.png'), other);
    fs.writeFileSync(path.join(term.tempDir, '_graph.png'), png); // same as the last capture
    done(backend, 1);
    assert.deepEqual(state.graphs, ['_cap_1_1.png', '_cap_1_2.png']);
    term.dispose();
});

test('a fallback graph from a nested do-file is shown once, not again by later runs', () => {
    const { backend, term, state } = setup();
    term.sendCode('do "nested.do"');
    fs.writeFileSync(path.join(term.tempDir, '_graph.png'), Buffer.alloc(300, 3));
    done(backend, 1);
    assert.deepEqual(state.graphs, ['_graph.png']);
    // later runs leave the stale file untouched: no duplicate plot
    type(term, 'summarize price\r');
    done(backend, 2);
    term.sendCode('summarize price');
    done(backend, 3);
    assert.deepEqual(state.graphs, ['_graph.png']);
    // a genuinely new export (new mtime) is shown
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(term.tempDir, '_graph.png'), Buffer.alloc(300, 4));
    fs.utimesSync(path.join(term.tempDir, '_graph.png'), future, future);
    type(term, 'histogram x\r');
    done(backend, 4);
    assert.deepEqual(state.graphs, ['_graph.png', '_graph.png']);
    term.dispose();
});

test('CRLF user code is normalized in the temp do-file', () => {
    const { backend, term } = setup();
    term.sendCode('display 1\r\ndisplay 2\r\n');
    const file = backend.batches[0].find((c) => c.startsWith('do ')).match(/`"(.*)"'/)[1];
    assert.ok(!fs.readFileSync(file, 'utf-8').includes('\r'));
    term.dispose();
});

test('the working directory change is quiet and uses a forward-slash path', () => {
    const { backend, term, plain } = setup();
    term.sendCode('display 1', 'C:\\Users\\me\\proj');
    assert.equal(backend.batches[0][0], 'quietly cd `"C:/Users/me/proj"\'');
    backend.fire('output', '. quietly cd `"C:/Users/me/proj"\'\n');
    assert.ok(!plain().includes('quietly cd'));
    term.dispose();
});
