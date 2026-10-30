const test = require('node:test');
const assert = require('node:assert/strict');

const { OutputProcessor } = require('../out/outputProcessor.js');

const palette = { prompt: '<P>', cmd: '<C>', err: '<E>', errBg: '<E>', table: '<T>', dim: '<D>', bold: '<B>', reset: '</>' };
const TMP = '/tmp/stata-vsc-abc123';

function create() {
    const errors = [];
    const processor = new OutputProcessor({
        palette,
        internalMarkers: [TMP],
        onError: (message) => errors.push(message),
    });
    return { processor, errors };
}

/** Feed the text in the given chunks, then flush and close out the batch. */
function run(chunks, setup) {
    const { processor, errors } = create();
    if (setup) { setup(processor); }
    let out = '';
    for (const chunk of chunks) { out += processor.write(chunk); }
    out += processor.flushPending();
    return { out, errors };
}

function splitEvery(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) { chunks.push(text.slice(i, i + size)); }
    return chunks;
}

const SESSION = [
    '',
    '. do `"' + TMP + '/_run_1.do"\'',
    '',
    '. summarize price',
    '',
    '    Variable |        Obs        Mean',
    '-------------+--------------------------',
    '       price |         74    6165.257',
    '',
    '. run `"' + TMP + '/_post.do"\'',
    '. capture quietly graph export `"' + TMP + '/_cap_1_1.png"\', as(png) width(800) replace',
    '. regress price nosuch',
    'variable nosuch not found',
    'r(111);',
    '',
    'end of do-file',
    '',
    'r(111);',
    '',
].join('\n');

test('output is identical however the backend chunks it', () => {
    const whole = run([SESSION]).out;
    assert.ok(whole.includes('<C>. summarize price</>'));
    for (const size of [1, 2, 3, 5, 7, 13, 31, 64]) {
        assert.equal(run(splitEvery(SESSION, size)).out, whole, `chunk size ${size}`);
    }
});

test('internal commands and do-file noise are filtered, including wrapped lines', () => {
    const wrapped = '. do `"' + TMP + '/_run_1\n> .do"\'\n. summarize price\n';
    const { out } = run([wrapped]);
    assert.equal(out.replace(/<[A-Z/]+>/g, ''), '. summarize price\r\n');
    for (const size of [1, 4, 9]) {
        assert.equal(run(splitEvery(wrapped, size)).out, out);
    }
    assert.ok(!run([SESSION]).out.includes('stata-vsc-'));
    assert.ok(!run([SESSION]).out.includes('end of do-file'));
    assert.ok(!run([SESSION]).out.includes('graph export'));
});

test('internal commands are recognized by shape even when the path is split', () => {
    const { out } = run(['. run `"/tmp/stata-vs\n> c-abc123/_post.do"\'\nhello\n']);
    assert.equal(out, 'hello\r\n');
});

test('user commands with compound-quoted paths outside the session dir stay visible', () => {
    const { out, errors } = run(['. do `"$root/clean.do"\'\nfile $root/clean.do not found\nr(601);\n']);
    assert.match(out, /do `"\$root\/clean\.do"'/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\. do `"\$root\/clean\.do"'/);
    assert.ok(run(['. graph export `"$out/fig1.png"\', replace\n']).out.includes('graph export'));
});

test('the r(N); Stata repeats after end of do-file is shown once', () => {
    const plain = run([SESSION]).out.replace(/<[A-Z/]+>/g, '');
    assert.equal((plain.match(/r\(111\);/g) || []).length, 1);
});

test('errors are reported once, with their message, and the repeat after end of do-file is ignored', () => {
    const { errors } = run([SESSION]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], '. regress price nosuch\nvariable nosuch not found\nr(111);');
});

test('error reporting does not depend on chunking', () => {
    const expected = run([SESSION]).errors;
    assert.deepEqual(run(splitEvery(SESSION, 1)).errors, expected);
    assert.deepEqual(run(splitEvery(SESSION, 11)).errors, expected);
});

test('error styling ends at a blank line instead of coloring everything after it', () => {
    const { out } = run(['invalid something\nmore detail\n\nnormal output\n']);
    assert.ok(out.includes('<E>invalid something</>'));
    assert.ok(out.includes('<E>more detail</>'));
    assert.ok(out.includes('normal output\r\n'));
    assert.ok(!out.includes('<E>normal output'));
});

test('echo of interactively typed commands is hidden once, in order', () => {
    const text = '. summarize price\nresult\n. summarize price\nsecond\n';
    const { out } = run([text], (p) => p.expectEcho(1, 'summarize price'));
    assert.equal(out.replace(/<[A-Z/]+>/g, ''), 'result\r\n. summarize price\r\nsecond\r\n');
});

test('wrapped echo of a long typed command is hidden', () => {
    const cmd = 'display "' + 'x'.repeat(200) + '"';
    const echoed = '. ' + cmd.slice(0, 78) + '\n> ' + cmd.slice(78, 150) + '\n> ' + cmd.slice(150) + '\n' + 'x'.repeat(200) + '\n';
    for (const size of [1000, 1, 17]) {
        const { out } = run(splitEvery(echoed, size), (p) => p.expectEcho(1, cmd));
        assert.equal(out, 'x'.repeat(200) + '\r\n', `chunk ${size}`);
    }
});

test('echo of a typed brace block is hidden including numbered continuation lines', () => {
    const text = '. forvalues i = 1/2 {\n  2.     display `i\'\n  3. }\n1\n2\n';
    const { out } = run([text], (p) => p.expectEcho(1, 'forvalues i = 1/2 {', 3));
    assert.equal(out, '1\r\n2\r\n');
});

test('unmatched echo expectations expire with their batch', () => {
    const { processor } = create();
    processor.expectEcho(1, 'summarize price');
    processor.batchDone(1);
    const out = processor.write('. summarize price\nresult\n');
    assert.equal(out, '<C>. summarize price</>\r\nresult\r\n');
});

test('bare prompts are dropped and rejoined with what follows', () => {
    const { processor } = create();
    let out = processor.write('\n. ');
    out += processor.flushPending();
    assert.equal(out, '');
    out += processor.write('summarize price\nresult\n');
    // the pending blank line from the prompt's leading newline is kept before a visible line
    assert.equal(out, '\r\n<C>. summarize price</>\r\nresult\r\n');
});

test('blank runs collapse and blanks before hidden lines are dropped', () => {
    const { out } = run(['a\n\n\n\nb\n\n. run `"' + TMP + '/_post.do"\'\n\n']);
    assert.equal(out, 'a\r\n\r\nb\r\n');
});

test('other partial lines (such as --more--) are shown after a pause', () => {
    const { processor } = create();
    assert.equal(processor.write('--more-- '), '');
    assert.equal(processor.flushPending(), '--more-- ');
    assert.equal(processor.midLine, true);
    // the newline that ends the flushed line is still emitted
    assert.equal(processor.write('\nnext\n'), '\r\nnext\r\n');
});

test('table separators and echoes are colored', () => {
    const { out } = run(['----+----\n. gen x = 1\n']);
    assert.ok(out.includes('<T>----+----</>'));
    assert.ok(out.includes('<C>. gen x = 1</>'));
});

test('backend stderr is shown in the error color', () => {
    const { processor } = create();
    assert.equal(processor.writeStderr('boom\n'), '<E>boom\r\n</>');
});

test('the error message starts at the failing command, not at earlier echoed lines or indented help text', () => {
    const text = [
        '. * a comment echo',
        '. reshape long, i(id)',
        'invalid syntax',
        '    You should have typed',
        '        . reshape wide varlist, ...',
        '    or more help',
        'r(198);',
        '',
    ].join('\n');
    const { errors } = run([text]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].split('\n')[0], '. reshape long, i(id)');
    assert.ok(errors[0].endsWith('r(198);'));
});
