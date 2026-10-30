const test = require('node:test');
const assert = require('node:assert/strict');

const { highlightStata } = require('../out/stataHighlight.js');
const { OutputProcessor } = require('../out/outputProcessor.js');
require('./helpers/fakeVscode.js').install();
const { linesizeFor } = require('../out/stataTerminal.js');

const P = { command: '<C>', keyword: '<K>', string: '<S>', macro: '<M>', number: '<N>', comment: '<#>', func: '<F>', reset: '</>' };
const hl = (code, start = true) => highlightStata(code, P, start);

test('commands, prefixes, keywords, macros, strings, numbers and functions', () => {
    assert.equal(hl('quietly: reg `y\' x if x > 1.5e3, robust'), '<K>quietly</>: <C>reg</> <M>`y\'</> x <K>if</> x > <N>1.5e3</>, robust');
    assert.equal(hl('by g: summarize x'), '<K>by</> g: <C>summarize</> x');
    assert.equal(hl('gen z = "${root}/a" + abs(x)'), '<C>gen</> z = <S>"</><M>${root}</><S>/a"</> + <F>abs</>(x)');
    assert.equal(hl('di `"say "hi""\''), '<C>di</> <S>`"say "hi""\'</>');
});

test('comments, display formats and factor notation', () => {
    assert.equal(hl('* a comment'), '<#>* a comment</>');
    assert.equal(hl('x * 2', false), 'x * <N>2</>');
    assert.equal(hl('summarize x // why'), '<C>summarize</> x <#>// why</>');
    assert.equal(hl('di %6.3f _b[2.race]'), '<C>di</> <N>%6.3f</> _b[2.race]');
    assert.equal(hl('reg y i.race 2.x'), '<C>reg</> y i.race 2.x');
});

test('a continuation line does not start with a command', () => {
    assert.equal(hl('e])) ")"', false), 'e])) <S>")"</>');
});

test('echoed commands are highlighted, including numbered block lines, and spaced apart', () => {
    const p = new OutputProcessor({
        palette: { prompt: '<P>', cmd: '<C>', err: '<E>', errBg: '<E>', table: '<T>', dim: '<D>', bold: '', reset: '</>' },
        internalMarkers: ['/tmp/stata-vsc-x'],
        highlight: (code, start) => `[${start ? 'S' : 'c'}:${code}]`,
        spaceCommands: true,
    });
    const out = p.write('. foreach y of local o {\n  2.     di "`y\'"\n  3. }\nwage\n. summarize x\n');
    assert.equal(out,
        '\r\n<P>.</> [S:foreach y of local o {]\r\n'
        + '<D>  2.</> [S:    di "`y\'"]\r\n'
        + '<D>  3.</> [S:}]\r\n'
        + 'wage\r\n'
        + '\r\n<P>.</> [S:summarize x]\r\n');
    // numbered output that does not follow an echo (e.g. `list`) is left alone
    assert.equal(p.write('\n  1. | 5 |\n'), '\r\n  1. | 5 |\r\n');
});

test('Stata linesize follows the terminal width within Stata limits', () => {
    assert.equal(linesizeFor(120), 119);
    assert.equal(linesizeFor(60), 80);
    assert.equal(linesizeFor(400), 255);
});
