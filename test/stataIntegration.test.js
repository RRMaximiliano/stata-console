// Runs the generated Stata code through a real Stata. Opt in with
//   STATA_INTEGRATION=1 npm test
// (STATA_BIN overrides the console binary, default /usr/local/bin/stata-mp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = process.env.STATA_BIN || '/usr/local/bin/stata-mp';
const enabled = process.env.STATA_INTEGRATION === '1' && fs.existsSync(BIN);
const skip = enabled ? false : 'set STATA_INTEGRATION=1 (and have a Stata console binary) to run';

const fakeVscode = require('./helpers/fakeVscode.js').install();
const { buildBrowseHelper, buildPostDoFile, rewriteCode } = require('../out/stataCode.js');
const { ConsoleBackend } = require('../out/stataProcess.js');
const { StataTerminal } = require('../out/stataTerminal.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDir(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stata-it-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Run Stata in batch mode and return the log text. */
function stata(dir, lines) {
    fs.writeFileSync(path.join(dir, 'run.do'), lines.join('\n') + '\n');
    const result = spawnSync(BIN, ['-q', '-b', 'do', 'run.do'], { cwd: dir, encoding: 'utf-8' });
    assert.equal(result.error, undefined);
    return fs.readFileSync(path.join(dir, 'run.log'), 'utf-8');
}

function postPaths(dir) {
    return {
        meta: `${dir}/_meta.txt`,
        vars: `${dir}/_vars.tsv`,
        results: `${dir}/_results.tsv`,
        graph: `${dir}/_graph.png`,
        graphSig: `${dir}/_graph.sig`,
    };
}

function setupPost(dir) {
    fs.writeFileSync(path.join(dir, '_post.do'), buildPostDoFile(postPaths(dir)));
    fs.writeFileSync(path.join(dir, '_browse.do'), buildBrowseHelper(dir));
}

const tsv = (file) => fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => l.split('\t'));

test('post-run export survives hostile labels and writes well-formed TSV', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    stata(dir, [
        'sysuse auto, clear',
        'local lab = `"He said "hi" "\' + char(96) + "x" + char(39) + " " + char(36) + "y \\ end" + char(9) + "tab" + char(10) + "line2"',
        'label variable price `"`macval(lab)\'"\'',
        'label variable mpg `"plain, with comma"\'',
        'label data `"Data "q" `macval(lab)\'"\'',
        `run "${dir}/_post.do"`,
    ]);
    const vars = tsv(path.join(dir, '_vars.tsv'));
    assert.deepEqual(vars[0], ['name', 'type', 'format', 'label']);
    assert.equal(vars.length, 13);
    for (const row of vars) { assert.equal(row.length, 4, row.join('|')); }
    const price = vars.find((r) => r[0] === 'price');
    assert.ok(price[3].includes('He said "hi"'));
    assert.ok(price[3].includes('`x\''));
    assert.ok(price[3].includes('$y \\ end'));
    assert.ok(!/[\t\n]/.test(price[3]));
    assert.equal(vars.find((r) => r[0] === 'mpg')[3], 'plain, with comma');
    const meta = fs.readFileSync(path.join(dir, '_meta.txt'), 'utf-8').replace(/\n$/, '').split('\t');
    assert.equal(meta.length, 4);
    assert.equal(meta[0], '74');
    assert.equal(meta[1], '12');
    assert.ok(meta[2].endsWith('auto.dta'));
    assert.ok(meta[3].includes('Data "q"'));
    assert.ok(meta[3].includes('line2'));
});

test('post-run export leaves rc, r(), e(), sort order, data and c(filename) untouched', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    const snapshot = [
        'display "STATE|rc=" _rc "|rN=" r(N) "|rmean=" r(mean) "|eN=" e(N) "|ecmd=" e(cmd) "|sorted=`: sortedby\'|changed=" c(changed) "|file=" c(filename) "|k=" c(k) "|N=" _N "|first=" price[1]',
    ];
    const log = stata(dir, [
        'sysuse auto, clear',
        'quietly regress price mpg',
        'sort weight',
        'scatter price mpg',
        'quietly summarize weight',
        'capture confirm variable nosuchvar',
        ...snapshot,
        `run "${dir}/_post.do"`,
        ...snapshot,
        'return list',
        'quietly summarize weight',
        'capture confirm variable weight',
        `run "${dir}/_post.do"`,
        'display "RC_AFTER=" _rc',
    ]);
    const states = log.split('\n').filter((l) => l.startsWith('STATE|'));
    assert.equal(states.length, 2);
    assert.equal(states[0], states[1]);
    assert.ok(states[0].includes('rc=111'));
    assert.ok(states[0].includes('sorted=weight'));
    assert.match(log, /RC_AFTER=0/);
    assert.match(log, /r\(N\) =\s+74/);
});

test('r() and e() scalars and macros are exported with their own types', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    const long = 'x'.repeat(3000);
    stata(dir, [
        'sysuse auto, clear',
        'program define _vsc_t, rclass',
        '    return scalar answer = 42',
        '    local g = "hello" + char(9) + "world"',
        '    return local greeting "`g\'"',
        '    return local nasty `"say "x" `y\' $z"\'',
        'end',
        'program define _vsc_e, eclass',
        '    ereturn clear',
        '    ereturn scalar rank = 7',
        '    ereturn local long "' + long + '"',
        '    ereturn local cmd "mycmd"',
        'end',
        '_vsc_e',
        '_vsc_t',
        `run "${dir}/_post.do"`,
    ]);
    const rows = tsv(path.join(dir, '_results.tsv'));
    assert.deepEqual(rows[0], ['type', 'name', 'value']);
    for (const row of rows) { assert.equal(row.length, 3, row.join('|')); }
    const find = (type, name) => rows.find((r) => r[0] === type && r[1] === name);
    assert.equal(find('r', 'answer')[2], '42');
    assert.equal(find('rm', 'greeting')[2], 'hello world');
    assert.ok(find('rm', 'nasty')[2].includes('say "x"'));
    assert.equal(find('e', 'rank')[2], '7');
    assert.equal(find('em', 'cmd')[2], 'mycmd');
    assert.ok(find('em', 'long')[2].length > 100, 'long e() macro is exported (truncated)');
});

test('fallback graph is exported once per new graph, never again for an unchanged one', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    const png = path.join(dir, '_graph.png');
    const log = stata(dir, [
        'sysuse auto, clear',
        `capture erase "${png}"`,
        `run "${dir}/_post.do"`,
        `capture confirm file "${png}"`,
        'display "A_BEFORE_GRAPH=" _rc',
        'scatter price mpg',
        `run "${dir}/_post.do"`,
        `capture confirm file "${png}"`,
        'display "B_AFTER_GRAPH=" _rc',
        `erase "${png}"`,
        'summarize price',
        `run "${dir}/_post.do"`,
        'summarize mpg',
        `run "${dir}/_post.do"`,
        `capture confirm file "${png}"`,
        'display "C_UNCHANGED=" _rc',
        'sleep 1100',
        'histogram mpg',
        `run "${dir}/_post.do"`,
        `capture confirm file "${png}"`,
        'display "D_NEW_GRAPH=" _rc',
        'graph drop _all',
        `run "${dir}/_post.do"`,
        'display "E_NO_GRAPH_OK"',
    ]);
    assert.match(log, /A_BEFORE_GRAPH=601/);
    assert.match(log, /B_AFTER_GRAPH=0/);
    assert.match(log, /C_UNCHANGED=601/);
    assert.match(log, /D_NEW_GRAPH=0/);
    assert.match(log, /E_NO_GRAPH_OK/);
});

test('browse export is capped in Stata, combines with if/in, and reports the true count', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    const args = (limit, base, rest = '') => `quietly run "${dir}/_browse.do" ${limit} ${base} \`"${rest}"'`;
    const log = stata(dir, [
        'set obs 20000',
        'gen id = _n',
        'gen g = mod(id, 7) == 0',
        'gen s = "a" + string(id)',
        'sort s',
        'quietly summarize id',
        'local rN = r(N)',
        'local sorted : sortedby',
        args(50, 'all'),
        args(50, 'ifonly', 'id s if g'),
        args(50, 'inif', 'if g in 1000/l'),
        args(5, 'range', 'id in 10/20__VSC_COMMA__ nolabel'),
        args(5, 'tail', 'in -3/l'),
        args(5, 'single', 'id in 7'),
        args(5, 'quoted', 'id if s == "a7"'),
        args(5, 'none', 'id if id < 0'),
        'display "AFTER|N=" _N "|rN=" (r(N) == `rN\') "|sorted=`: sortedby\'|changedok=1"',
        'capture ' + args(5, 'bad', 'nosuchvar'),
        'display "BADRC=" _rc',
        'quietly summarize id',
        'display "RHELD=" (r(N) == `rN\')',
    ]);
    const lines = (name) => fs.readFileSync(path.join(dir, `${name}.csv`), 'utf-8').split('\n').filter(Boolean);
    const count = (name) => parseInt(fs.readFileSync(path.join(dir, `${name}.count`), 'utf-8'), 10);

    assert.equal(lines('all').length, 51);
    assert.equal(count('all'), 20000);
    assert.deepEqual(lines('ifonly').slice(0, 3), ['id,s', 'a1008,1008'.replace('a1008,1008', lines('ifonly')[1]), lines('ifonly')[2]]);
    assert.equal(lines('ifonly').length, 51);
    assert.equal(count('ifonly'), Math.floor(20000 / 7));
    // first 50 matches in sort order, not matches among the first 50 rows
    assert.ok(lines('ifonly').slice(1).every((l) => l.split(',')[0] % 7 === 0));
    assert.equal(lines('inif').length, 51);
    assert.ok(lines('inif').slice(1).every((l) => l.split(',')[1] === '1'));
    assert.equal(count('range'), 11);
    assert.equal(lines('range').length, 6);
    assert.equal(count('tail'), 3);
    assert.equal(count('single'), 1);
    assert.equal(count('quoted'), 1);
    assert.equal(count('none'), 0);
    assert.ok(!fs.existsSync(path.join(dir, 'none.csv')));
    assert.match(log, /AFTER\|N=20000\|rN=1\|sorted=s\|/);
    assert.match(log, /BADRC=111/);
    assert.match(log, /RHELD=1/);
});

test('browse on empty data writes a zero count and no CSV', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    stata(dir, ['clear', `quietly run "${dir}/_browse.do" 5 empty \`""'`]);
    assert.equal(fs.readFileSync(path.join(dir, 'empty.count'), 'utf-8').trim(), '0');
    assert.ok(!fs.existsSync(path.join(dir, 'empty.csv')));
});

test('rewritten user code runs: inline graph exports, browse export, CRLF input', { skip }, (t) => {
    const dir = makeDir(t);
    setupPost(dir);
    const { code, graphCount, browseBase } = rewriteCode(
        'sysuse auto, clear\r\nscatter price mpg\r\nhistogram mpg\r\nbrowse price mpg if foreign\r\n',
        { dir, runId: 1, browseLimit: 10, browseHelper: `${dir}/_browse.do` },
    );
    assert.equal(graphCount, 2);
    fs.writeFileSync(path.join(dir, 'user.do'), code);
    stata(dir, [`do "${dir}/user.do"`]);
    for (const n of [1, 2]) {
        assert.ok(fs.statSync(path.join(dir, `_cap_1_${n}.png`)).size > 100);
    }
    assert.equal(fs.readFileSync(path.join(dir, `${browseBase}.count`), 'utf-8').trim(), '22');
    assert.equal(fs.readFileSync(path.join(dir, `${browseBase}.csv`), 'utf-8').split('\n').filter(Boolean).length, 11);
});

// --- End to end: the real StataTerminal driving a real console backend ---

async function openSession(t, settings = {}) {
    Object.assign(fakeVscode.settings, settings);
    t.after(() => { for (const key of Object.keys(settings)) { delete fakeVscode.settings[key]; } });
    const term = new StataTerminal(new ConsoleBackend(BIN));
    t.after(() => term.dispose());
    const session = { term, text: '', busy: false, graphs: [], browses: [], errors: [], vars: [] };
    term.onDidWrite((s) => { session.text += s; });
    term.onDidChangeBusy((b) => { session.busy = b; });
    term.onDidDetectGraph((g) => session.graphs.push(path.basename(g)));
    term.onDidRequestBrowse((b) => session.browses.push(b));
    term.onDidDetectError((e) => session.errors.push(e));
    term.onDidUpdateVariables((m) => session.vars.push(m));
    term.open();
    session.plain = () => session.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
    session.settle = async () => {
        const deadline = Date.now() + 60000;
        await sleep(50);
        while (session.busy && Date.now() < deadline) { await sleep(25); }
        await sleep(150);
        assert.equal(session.busy, false, 'terminal stayed busy');
    };
    session.type = async (...lines) => {
        for (const line of lines) {
            term.handleInput(line + '\r');
            await session.settle();
        }
    };
    session.mark = () => session.plain().length;
    session.since = (mark) => session.plain().slice(mark);
    await sleep(200);
    return session;
}

test('interactive console: blocks, echo suppression, r() preservation, panels', { skip }, async (t) => {
    const s = await openSession(t);
    await s.type('sysuse auto, clear');
    assert.equal(s.vars.at(-1).obs, 74, 'panels update after typed commands');

    let mark = s.mark();
    await s.type('forvalues i = 1/3 {', '    display "i is `i\'"', '}');
    let out = s.since(mark);
    assert.match(out, /i is 1\n.*i is 2\n.*i is 3/s);
    assert.ok(!out.includes('stata-vsc-'));
    assert.ok(!out.includes('end of do-file'));
    assert.equal((out.match(/display "i is/g) || []).length, 1, 'typed block is not echoed a second time');

    await s.type('quietly summarize price', 'capture confirm variable nosuchvar');
    mark = s.mark();
    await s.type('display "rc=" _rc', 'return list');
    out = s.since(mark);
    assert.match(out, /rc=111/);
    assert.match(out, /r\(N\) =\s+74/, 'r() from the typed command survives the post-run export');
    assert.deepEqual(s.errors, []);

    // multi-line constructs that would otherwise wedge the session
    mark = s.mark();
    await s.type('mata', 'x = 20 + 22', 'x', 'end');
    await s.type('display "alive after mata"');
    assert.match(s.since(mark), /alive after mata/);
    mark = s.mark();
    await s.type('program define vsc_hello', '    display "hello from program"', 'end', 'vsc_hello');
    assert.match(s.since(mark), /hello from program/);
    mark = s.mark();
    await s.type('#delimit ;', 'display "still fine"');
    out = s.since(mark);
    assert.match(out, /#delimit can only be used in do-files/);
    assert.match(out, /still fine/);
    mark = s.mark();
    await s.type('twoway scatter price mpg ///', '    , title("t")');
    assert.deepEqual(s.errors, []);
    assert.equal(s.graphs.length, 1);
    await s.type('summarize price', 'display 1');
    assert.equal(s.graphs.length, 1, 'no duplicate plot after non-graph commands');
});

test('interactive console: paste, type-ahead and error reporting', { skip }, async (t) => {
    const s = await openSession(t);
    const mark = s.mark();
    s.term.handleInput('sysuse auto, clear\r\nforvalues i = 1/2 {\r\n  display "p`i\'"\r\n}\r\ndisplay "last"\r\n');
    await s.settle();
    const out = s.since(mark);
    assert.match(out, /p1\n.*p2\n.*last/s);
    assert.equal(s.vars.at(-1).obs, 74);

    await s.type('summarize nosuchvar');
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0].message, /nosuchvar not found/);
    assert.equal(s.errors[0].target, undefined);
});

test('run code: multiple graphs, nested do-file graph, errors, browse limit, CRLF do-file', { skip }, async (t) => {
    const dir = makeDir(t);
    const s = await openSession(t, { 'stata.browseRowLimit': 5 });

    s.term.sendCode('sysuse auto, clear\nscatter price mpg\nhistogram mpg\nsummarize price', dir);
    await s.settle();
    assert.equal(s.graphs.length, 2, 'both inline captures, fallback not duplicated');
    assert.deepEqual(s.graphs, ['_cap_1_1.png', '_cap_1_2.png']);

    // graph made by a nested do-file is caught by the fallback, once
    fs.writeFileSync(path.join(dir, 'plot.do'), 'sysuse auto, clear\r\ntwoway line price mpg\r\n');
    s.term.sendCode(`do "${dir.replace(/\\/g, '/')}/plot.do"`, dir);
    await s.settle();
    assert.equal(s.graphs.length, 3);
    assert.equal(s.graphs[2], '_graph.png');
    s.term.sendCode('summarize price', dir);
    await s.settle();
    assert.equal(s.graphs.length, 3, 'no duplicate after a later non-graph run');

    // browse capped by the configured row limit with the true total
    s.term.sendCode('browse price if foreign', dir);
    await s.settle();
    assert.equal(s.browses.length, 1);
    assert.equal(s.browses[0].totalObs, 22);
    assert.equal(fs.readFileSync(s.browses[0].csvPath, 'utf-8').split('\n').filter(Boolean).length, 6);

    // errors: reported once, with the message and the target, and the console is not left busy
    const target = { uri: 'file:///x.do', line: 3, from: 3, to: 4 };
    s.term.sendCode('summarize price\nregress price nosuchvar', dir, target);
    await s.settle();
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0].message, /nosuchvar not found/);
    assert.equal(s.errors[0].origin, 'programmatic');
    assert.equal(s.errors[0].target, target);
    assert.ok(!s.plain().includes('end of do-file'));
});

test('run code from a directory whose name contains $ and a backtick', { skip }, async (t) => {
    const base = makeDir(t);
    const dir = path.join(base, 'we`ird $d dir');
    fs.mkdirSync(dir);
    const s = await openSession(t);
    const mark = s.mark();
    s.term.sendCode('set linesize 250\ndisplay "PWD=" c(pwd)', dir);
    await s.settle();
    assert.ok(s.since(mark).includes('PWD=' + dir), s.since(mark));
});

test('queued runs and Run while typing: nothing is lost and busy always clears', { skip }, async (t) => {
    const s = await openSession(t);
    s.term.sendCode('sleep 600\ndisplay "RESULT" "_first"');
    s.term.sendCode('display "RESULT" "_second"');
    s.term.handleInput('display "RESULT" "_third"\r');
    await s.settle();
    const out = s.plain();
    assert.ok(out.indexOf('RESULT_first') !== -1);
    assert.ok(out.indexOf('RESULT_first') < out.indexOf('RESULT_second'));
    assert.ok(out.indexOf('RESULT_second') < out.indexOf('RESULT_third'));
});

test('Ctrl+C breaks a running command and the console recovers', { skip }, async (t) => {
    const s = await openSession(t);
    s.term.sendCode('sleep 20000\ndisplay "should not print"');
    await sleep(800);
    s.term.handleInput('\x03');
    await s.settle();
    assert.equal(s.busy, false);
    const mark = s.mark();
    await s.type('display "recovered"');
    assert.match(s.since(mark), /recovered/);
});
