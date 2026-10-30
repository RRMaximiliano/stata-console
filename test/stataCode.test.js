const test = require('node:test');
const assert = require('node:assert/strict');

const {
    browseArgs,
    buildBrowseHelper,
    buildGraphExportHelper,
    buildPostDoFile,
    isGraphCommand,
    rewriteCode,
    sanitizeField,
    stataPathText,
    stataQuote,
} = require('../out/stataCode.js');

const options = {
    dir: '/tmp/stata-vsc-abc',
    runId: 7,
    browseLimit: 500,
    browseHelper: '/tmp/stata-vsc-abc/_browse.do',
};

test('with a graph helper, graph capture preserves _rc and skips failed captured graphs', () => {
    const o = { ...options, graphHelper: '/tmp/stata-vsc-abc/_graph_export.do' };
    const { code, graphCount } = rewriteCode('scatter y x\ncapture scatter nosuch x\ncap noi histogram x', o);
    assert.equal(graphCount, 3);
    const runs = code.split('\n').filter((l) => l.startsWith('quietly run'));
    assert.equal(runs.length, 3);
    assert.match(runs[0], /_graph_export\.do"' `"\/tmp\/stata-vsc-abc\/_cap_7_1\.png"' 0 800$/);
    assert.match(runs[1], / 1 800$/);
    assert.match(runs[2], / 1 800$/);
    const helper = buildGraphExportHelper();
    assert.match(helper, /local _vsc_grc = _rc/);
    assert.match(helper, /capture error `_vsc_grc'/);
});

test('program dir/list abbreviations are not blocks that wait for end', () => {
    const { code } = rewriteCode('pr di\nbrowse', options);
    assert.ok(!code.includes('\nbrowse'), 'browse after `pr di` is still rewritten');
});

test('paths are converted to forward slashes and quoted for Stata', () => {
    assert.equal(stataPathText('C:\\Users\\me\\proj'), 'C:/Users/me/proj');
    assert.equal(stataQuote('C:\\Users\\me\\proj'), '`"C:/Users/me/proj"\'');
});

test('$ and backticks in paths are escaped so Stata does not expand them', () => {
    assert.equal(stataQuote('C:\\Users\\$name\\a`b'), '`"C:/Users/\\$name/a\\`b"\'');
});

test('sanitizeField flattens tabs and line breaks', () => {
    assert.equal(sanitizeField('a\tb\r\nc\nd'), 'a b c d');
});

test('graph commands are recognized, including prefixes; non-plots are excluded', () => {
    for (const c of ['scatter y x', 'twoway (line y x)', 'histogram x, bin(10)', 'graph bar y', 'gr box y', 'quietly scatter y x',
        'by g: scatter y x', 'capture noisily histogram x', 'kdensity x', 'coefplot', 'tsline y']) {
        assert.equal(isGraphCommand(c), true, c);
    }
    for (const c of ['graph export "a.png"', 'graph save g', 'graph display', 'graph drop _all', 'summarize x', 'regress y x', '', '* scatter']) {
        assert.equal(isGraphCommand(c), false, c);
    }
});

test('a graph export follows each graph command with a unique file', () => {
    const r = rewriteCode('sysuse auto, clear\nscatter price mpg\nhistogram mpg\nsummarize price', options);
    assert.equal(r.graphCount, 2);
    assert.equal(r.code, [
        'sysuse auto, clear',
        'scatter price mpg',
        'capture quietly graph export `"/tmp/stata-vsc-abc/_cap_7_1.png"\', as(png) width(800) replace',
        'histogram mpg',
        'capture quietly graph export `"/tmp/stata-vsc-abc/_cap_7_2.png"\', as(png) width(800) replace',
        'summarize price',
        '',
    ].join('\n'));
});

test('the export goes after the last line of a /// continued graph command', () => {
    const r = rewriteCode('twoway ///\n    (scatter y x) ///\n    , title("t")\ndisplay 1', options);
    const lines = r.code.split('\n');
    assert.equal(lines[2], '    , title("t")');
    assert.match(lines[3], /^capture quietly graph export/);
    assert.equal(lines[4], 'display 1');
    assert.equal(r.graphCount, 1);
});

test('commands inside a loop body get the export inside the loop', () => {
    const r = rewriteCode('foreach v of varlist a b {\n    scatter `v\' x\n}', options);
    assert.deepEqual(r.code.split('\n').map((l) => l.slice(0, 7)), ['foreach', '    sca', 'capture', '}', '']);
});

test('nodraw graphs and graphs in #delimit, mata, program and comment regions are left alone', () => {
    const src = [
        'scatter y x, nodraw',
        '/*',
        'scatter y x',
        '*/',
        '#delimit ;',
        'scatter y x',
        ';',
        '#delimit cr',
        'mata',
        'scatter',
        'end',
        'program define p',
        '    scatter y x',
        'end',
        '// scatter y x',
        '* scatter y x',
    ].join('\n');
    const r = rewriteCode(src, options);
    assert.equal(r.graphCount, 0);
    assert.equal(r.code, src + '\n');
});

test('graph capture resumes after #delimit cr', () => {
    const r = rewriteCode('#delimit ;\nscatter y x\n;\n#delimit cr\nscatter y x', options);
    assert.equal(r.graphCount, 1);
});

test('browse and edit become a bounded Data Viewer export that keeps the user arguments', () => {
    const r = rewriteCode('browse price mpg if foreign, nolabel // look\nedit', options);
    assert.equal(r.browseBase, '_browse_7');
    assert.deepEqual(r.code.split('\n').slice(0, 2), [
        'quietly run `"/tmp/stata-vsc-abc/_browse.do"\' 500 _browse_7 `"price mpg if foreign__VSC_COMMA__ nolabel"\'',
        'quietly run `"/tmp/stata-vsc-abc/_browse.do"\' 500 _browse_7 `""\'',
    ]);
});

test('browse with /// continuation is joined into one command', () => {
    const r = rewriteCode('browse price ///\n    mpg if foreign\ndisplay 1', options);
    assert.deepEqual(r.code.split('\n').slice(0, 2), [
        'quietly run `"/tmp/stata-vsc-abc/_browse.do"\' 500 _browse_7 `"price mpg if foreign"\'',
        'display 1',
    ]);
});

test('browse inside mata or comments is untouched', () => {
    const src = 'mata\nbrowse\nend\n/*\nbrowse\n*/\n* browse\n// edit';
    assert.equal(rewriteCode(src, options).code, src + '\n');
});

test('commands that merely start with br or ed are not browse', () => {
    const src = 'bro = 1\nedit_x\nbrowser';
    assert.equal(rewriteCode(src, options).browseBase, undefined);
});

test('CRLF and bare CR line endings are normalized', () => {
    const r = rewriteCode('display 1\r\ndisplay 2\rdisplay 3\r\n', options);
    assert.equal(r.code, 'display 1\ndisplay 2\ndisplay 3\n\n');
    assert.ok(!r.code.includes('\r'));
});

test('browseArgs protects commas from run', () => {
    assert.equal(browseArgs(' x, nolabel '), '`"x__VSC_COMMA__ nolabel"\'');
});

test('every path in generated code uses forward slashes, even for Windows inputs', () => {
    const dir = 'C:\\Users\\me\\AppData\\Local\\Temp\\stata-vsc-x';
    const win = {
        meta: dir + '\\_meta.txt',
        vars: dir + '\\_vars.tsv',
        results: dir + '\\_results.tsv',
        graph: dir + '\\_graph.png',
        graphSig: dir + '\\_graph.sig',
    };
    const post = buildPostDoFile(win);
    const helper = buildBrowseHelper(dir);
    const rewritten = rewriteCode('scatter y x', { ...options, dir }).code;
    for (const text of [post, helper, rewritten]) {
        assert.ok(!/[A-Za-z]:\\/.test(text), 'no backslash drive paths');
        assert.ok(!/stata-vsc-x\\/.test(text), 'no backslash separators');
    }
    assert.ok(post.includes('C:/Users/me/AppData/Local/Temp/stata-vsc-x/_meta.txt'));
});

test('post do-file preserves user state: rc, r(), and never touches data', () => {
    const post = buildPostDoFile({ meta: '/m', vars: '/v', results: '/r', graph: '/g.png', graphSig: '/g.sig' });
    assert.match(post, /^local _vsc_rc = _rc$/m);
    assert.match(post, /^capture error `_vsc_rc'$/m);
    assert.ok(post.indexOf('_return hold') < post.indexOf('graph describe'));
    assert.ok(post.indexOf('graph describe') < post.indexOf('_return restore'));
    assert.ok(post.indexOf('_return restore') < post.indexOf('capture error'));
    assert.ok(!/\bds\b/.test(post), 'ds is r-class and would clobber r()');
    for (const forbidden of ['sort ', 'gen ', 'generate ', 'drop ', 'replace ', 'preserve', ' use ', 'clear']) {
        assert.ok(!post.includes(forbidden), `post must not run "${forbidden.trim()}"`);
    }
});

test('generated do-files have balanced braces', () => {
    for (const text of [buildPostDoFile({ meta: '/m', vars: '/v', results: '/r', graph: '/g', graphSig: '/s' }), buildBrowseHelper('/tmp/x')]) {
        const opens = (text.match(/\{/g) || []).length;
        const closes = (text.match(/\}/g) || []).length;
        assert.equal(opens, closes);
    }
});
