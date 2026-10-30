const test = require('node:test');
const assert = require('node:assert/strict');

const { InputAccumulator } = require('../out/inputAccumulator.js');
const { scanLine, countBraces } = require('../out/stataLexer.js');

function feed(lines) {
    const acc = new InputAccumulator();
    return lines.map((l) => acc.push(l));
}

test('program dir/list abbreviations do not wait for end; abbreviated prefixes before mata do', () => {
    const { startsEndBlock } = require('../out/stataLexer.js');
    for (const c of ['pr di', 'program di', 'program l', 'pr li _all', 'program list foo', 'program drop foo']) {
        assert.equal(startsEndBlock(c), false, c);
    }
    for (const c of ['mata', 'quie mata', 'quietly: mata', 'capt noi mata:', 'program define foo', 'pr foo', 'input x y']) {
        assert.equal(startsEndBlock(c), true, c);
    }
});

test('single complete lines pass straight through', () => {
    const [a, b] = feed(['summarize price // note', 'display "{"']);
    assert.deepEqual(a, { kind: 'line', code: 'summarize price // note' });
    assert.deepEqual(b, { kind: 'line', code: 'display "{"' });
});

test('blank and comment-only lines produce nothing to run', () => {
    const results = feed(['', '   ', '* a comment', '// another', '/* block */']);
    for (const r of results) { assert.deepEqual(r, { kind: 'empty' }); }
});

test('a brace block is collected until balanced and runs as one block', () => {
    const results = feed(['forvalues i = 1/3 {', '    display `i\'', '}']);
    assert.equal(results[0], null);
    assert.equal(results[1], null);
    assert.equal(results[2].kind, 'block');
    assert.equal(results[2].code, 'forvalues i = 1/3 {\n    display `i\'\n}');
    assert.equal(results[2].lines.length, 3);
});

test('braces inside strings, comments and ${} macros do not count', () => {
    const results = feed(['display "{"', 'display `"}"\'', 'display "a" // {', 'local x ${y}', 'display 1 /* { */']);
    for (const r of results) { assert.equal(r.kind, 'line'); }
});

test('nested braces and else branches', () => {
    const results = feed(['if 1 {', 'if 2 {', 'display 1', '}', '}']);
    assert.deepEqual(results.map((r) => r && r.kind), [null, null, null, null, 'block']);
    const same = feed(['if 1 { display 1 } else {', 'display 2', '}']);
    assert.deepEqual(same.map((r) => r && r.kind), [null, null, 'block']);
});

test('/// continuation joins lines', () => {
    const results = feed(['twoway scatter price mpg ///', '    , title("x")']);
    assert.equal(results[0], null);
    assert.equal(results[1].kind, 'block');
    assert.equal(results[1].lines.length, 2);
});

test('a trailing // comment is not a continuation, but /// is', () => {
    assert.equal(feed(['summarize price // ///x'])[0].kind, 'line');
    assert.equal(feed(['summarize price ///'])[0], null);
});

test('block comments span lines', () => {
    const results = feed(['/* start', 'middle {', 'end */ display 1']);
    assert.equal(results[0], null);
    assert.equal(results[1], null);
    assert.equal(results[2].kind, 'block');
});

test('a leading * only comments out a command, not a continuation line', () => {
    const results = feed(['gen z = x ///', '  * 2']);
    assert.equal(results[1].kind, 'block');
});

test('mata blocks wait for end', () => {
    const results = feed(['mata', 'x = 1', 'end']);
    assert.deepEqual(results.map((r) => r && r.kind), [null, null, 'block']);
    assert.equal(feed(['mata: x = 1'])[0].kind, 'line');
    assert.equal(feed(['mata:'])[0], null);
});

test('program define and input blocks wait for end', () => {
    assert.deepEqual(feed(['program define hello', 'display "hi"', 'end']).map((r) => r && r.kind), [null, null, 'block']);
    assert.deepEqual(feed(['capture program drop hello'])[0].kind, 'line');
    assert.deepEqual(feed(['program drop hello'])[0].kind, 'line');
    assert.deepEqual(feed(['input x y', '1 2', '3 4', 'end']).map((r) => r && r.kind), [null, null, null, 'block']);
    assert.deepEqual(feed(['python:', 'print(1)', 'end']).map((r) => r && r.kind), [null, null, 'block']);
});

test('commands that merely start like a block do not wait for end', () => {
    for (const cmd of ['predict yhat', 'preserve', 'probit y x', 'inpfile', 'matrix input', 'prove']) {
        assert.equal(feed([cmd])[0].kind, 'line', cmd);
    }
});

test('#delimit is rejected with an explanation instead of wedging the session', () => {
    const [r] = feed(['#delimit ;']);
    assert.equal(r.kind, 'rejected');
    assert.match(r.message, /do-file/);
});

test('reset abandons a half-typed block', () => {
    const acc = new InputAccumulator();
    assert.equal(acc.push('forvalues i = 1/3 {'), null);
    assert.equal(acc.pending, true);
    acc.reset();
    assert.equal(acc.pending, false);
    assert.deepEqual(acc.push('display 1'), { kind: 'line', code: 'display 1' });
});

test('blank lines inside a block are ignored; CRLF is tolerated', () => {
    const acc = new InputAccumulator();
    assert.equal(acc.push('if 1 {\r'), null);
    assert.equal(acc.push(''), null);
    const r = acc.push('}\r');
    assert.equal(r.code, 'if 1 {\n}');
});

test('continuation prompt reports the next line number', () => {
    const acc = new InputAccumulator();
    acc.push('forvalues i = 1/3 {');
    assert.deepEqual(acc.continuation, { lineNumber: 2, kind: 'brace' });
    const acc2 = new InputAccumulator();
    acc2.push('summarize price ///');
    assert.deepEqual(acc2.continuation, { lineNumber: 2, kind: 'other' });
});

test('scanLine strips comments and string contents', () => {
    const state = { blockDepth: 0 };
    assert.deepEqual(scanLine('a "b {" c // d', state), { code: 'a "" c ', continued: false, end: 10 });
    assert.equal(scanLine('x /// y', state).continued, true);
    assert.equal(scanLine('http://a.b "//"', state).code, 'http://a.b ""');
    assert.equal(countBraces('{ { }'), 1);
});
