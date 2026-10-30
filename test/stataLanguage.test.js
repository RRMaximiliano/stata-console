const test = require('node:test');
const assert = require('node:assert/strict');
const { scanStata, parseDefinitions, visibleMacros, macroReferenceAt } = require('../out/stataSyntax.js');
const { extractFileReferences, resolveFileLinks, resolveStataPath } = require('../out/stataFileLinks.js');
const { detectSection, buildOutline } = require('../out/stataOutline.js');
const { resolveCommand, COMMANDS, COMMAND_ALIASES } = require('../out/stataCommands.js');
const { macroCompletions, commandCompletionRange, declaredVariables } = require('../out/stataCompletions.js');

function links(text, files, document = '/project/main.do') {
    return resolveFileLinks(text, document, file => files.includes(file));
}

test('Windows drives and both slash styles resolve independently of the host platform', () => {
    const text = 'use C:\\data\\x.dta, clear\nsave "C:/data/saved", replace\ndo scripts\\setup\nrun "../next.do"';
    const targets = ['C:\\data\\x.dta', 'C:\\data\\saved.dta', 'D:\\project\\scripts\\setup.do', 'D:\\next.do'];
    const actual = links(text, targets, 'D:\\project\\main.do');
    assert.deepEqual(actual.map(link => link.target), targets);
    for (const link of actual) { assert.equal(text.slice(link.start, link.end), link.path); }
    assert.equal(resolveStataPath('C:relative.dta', 'D:\\project'), undefined);
    assert.equal(resolveStataPath('data\\x.dta', '/project'), '/project/data/x.dta');
});

test('UNC paths and mixed separators retain the network root', () => {
    const text = 'use "\\\\server\\share\\my data\\x.dta"\ninclude \\folder\\setup';
    assert.deepEqual(links(text, ['\\\\server\\share\\my data\\x.dta', 'C:\\folder\\setup.do'], 'C:/project/main.do').map(l => l.target), [
        '\\\\server\\share\\my data\\x.dta', 'C:\\folder\\setup.do',
    ]);
    assert.equal(resolveStataPath('//server/share/x.dta', '/project'), '\\\\server\\share\\x.dta');
});

test('using paths with spaces, prefixes, imports, exports and implicit extensions', () => {
    const text = [
        'qui import delimited using data/my data.csv, clear',
        'capture noisily merge m:1 id using "data/my data", nogen',
        'append using data/extra',
        'graph export "figures/plot.png", replace',
        'include setup',
        'use sample',
        'do task "argument with spaces"',
        'import excel "data/workbook.xlsx", firstrow',
        'bysort id: save "group.dta", replace',
    ].join('\n');
    const expected = ['data/my data.csv', 'data/my data.dta', 'data/extra.dta', 'figures/plot.png', 'setup.do', 'sample.dta', 'task.do', 'data/workbook.xlsx', 'group.dta'].map(p => `/project/${p}`);
    assert.deepEqual(links(text, expected).map(l => l.target), expected);
    assert.equal(extractFileReferences('display "using fake.dta"\n* use fake\n/* do fake */').length, 0);
});

test('globals expand in definition order and cd changes subsequent relative paths', () => {
    const text = [
        'global root "C:/project"',
        'global data "$root/data"',
        'use "${data}/first"',
        'cd "$root/scripts"',
        'do setup',
        'cd "../data"',
        'use second',
        'global root "D:/other"',
        'use "$root/third"',
    ].join('\n');
    const expected = ['C:\\project\\data\\first.dta', 'C:\\project\\scripts', 'C:\\project\\scripts\\setup.do', 'C:\\project\\data', 'C:\\project\\data\\second.dta', 'D:\\other\\third.dta'];
    assert.deepEqual(links(text, expected).map(l => l.target), expected);
});

test('unknown macros, expression globals, missing files and stat failures never make broken links', () => {
    const text = 'global root = c(pwd)\nuse "$root/x"\nuse "$undefined/x"\nuse "`tmp\'"\nuse missing\nuse existing';
    assert.deepEqual(links(text, ['/project/existing.dta']).map(l => l.target), ['/project/existing.dta']);
    assert.deepEqual(resolveFileLinks('use foo', '/project/x.do', () => { throw new Error('unavailable'); }), []);
    assert.deepEqual(links('cd "$unknown"\nuse foo', ['/project/foo.dta']), []);
    assert.deepEqual(links('use "https://example.com/x.dta"', ['https://example.com/x.dta']), []);
});

test('continued commands and semicolon-delimited commands preserve file ranges', () => {
    const text = 'import delimited /// comment\n    using "data.csv", clear\n#delimit ;\nuse "one"; do two;\n#delimit cr\nuse three';
    const actual = links(text, ['/project/data.csv', '/project/one.dta', '/project/two.do', '/project/three.dta']);
    assert.deepEqual(actual.map(l => l.target), ['/project/data.csv', '/project/one.dta', '/project/two.do', '/project/three.dta']);
    for (const link of actual) { assert.equal(text.slice(link.start, link.end), link.path); }
});

test('program bodies do not change the do-file working directory or global values', () => {
    const text = 'global root "/project"\nprogram define helper\ncd "/other"\nglobal root "/other"\nend\nuse "$root/x"';
    assert.deepEqual(links(text, ['/project/x.dta', '/other', '/other/x.dta']).map(l => l.target), ['/other', '/project/x.dta']);
});

test('lexer supports nested comments, strings, multiplication and comment continuations', () => {
    const text = '/* outer\n/* inner */\nuse hidden\n*/\ngen x = a * b\ndisplay `"http://host /* text */ `"nested"\'"\'\n// end\n';
    const source = scanStata(text);
    assert.equal(source.clean.includes('hidden'), false);
    assert.match(source.code, /a \* b/);
    assert.equal(source.code.includes('http'), false);
    assert.equal(source.clean.includes('http://host /* text */'), true);
    assert.equal(scanStata('gen x = 1 /// comment\n * 2').starComments.length, 0);
    const comment = scanStata('// comment\nnext');
    assert.equal(comment.contexts[10], 1);
});

test('command abbreviations resolve to canonical hover descriptions', () => {
    for (const [short, full] of Object.entries({ reg: 'regress', regr: 'regress', gen: 'generate', tab: 'tabulate', su: 'summarize', sum: 'summarize', bys: 'bysort', qui: 'quietly', cap: 'capture', noi: 'noisily' })) {
        assert.equal(resolveCommand(short).label, full);
    }
    for (const word of ['ivreghdfe', 'reghdfe', 'estout', 'esttab', 'outreg2', 'ftools', 'gtools', 'coefplot']) {
        assert.ok(resolveCommand(word), word);
    }
    assert.equal(new Set(COMMANDS.map(c => c.label)).size, COMMANDS.length);
    assert.ok(COMMAND_ALIASES.every(alias => resolveCommand(alias.label)));
});

test('completions suppress commands in comments and strings, but allow macro references in strings', () => {
    for (const text of ['/* nested /* inner */ comment', '// reg', '* reg', 'display "reg', 'display `"reg']) {
        assert.equal(commandCompletionRange(scanStata(text), text.length), undefined, text);
    }
    for (const text of ['reg', 'qui reg', 'capture noisily reg', 'bysort id: reg', 'by id: reg', 'import de']) {
        const range = commandCompletionRange(scanStata(text), text.length);
        assert.ok(range, text);
    }
    assert.equal(commandCompletionRange(scanStata('reg y x'), 7), undefined);
    const text = 'local outcome wage\nglobal root "C:/data"\ndisplay "`out';
    const suggestions = macroCompletions(scanStata(text), text.length);
    assert.equal(suggestions[0].insertText, '`outcome\'');
    const globalText = text + '\nuse "${ro';
    assert.equal(macroCompletions(scanStata(globalText), globalText.length)[0].insertText, '${root}');
});

test('macro completion replaces an existing quote/brace and respects program scope and redefinitions', () => {
    const text = 'local outside 1\nprogram p\nlocal inside 2\nlocal inside 3\ndisplay `ins\'\nend\ndisplay `out';
    const cursor = text.indexOf('`ins') + 4;
    const inside = macroCompletions(scanStata(text), cursor);
    assert.equal(inside.length, 1);
    assert.equal(inside[0].insertText, '`inside\'');
    assert.equal(text.slice(inside[0].start, inside[0].end), '`ins\'');
    assert.equal(inside[0].detail, 'local macro: 3');
    assert.equal(macroCompletions(scanStata(text), text.length)[0].insertText, '`outside\'');
    assert.deepEqual(declaredVariables('gen double wage = 1\negen group = group(id)\nrename group panel\n* gen fake = 2'), ['wage', 'panel']);
});

test('program and macro definitions ignore comments, support pr de, options, exact names and Mata end', () => {
    const text = '* program fake\npr de real, rclass\nlocal real 1\nmata:\nx = 1\nend\nend\nprogram short\nend\nlabel define yesno 0 "No"';
    const definitions = parseDefinitions(scanStata(text));
    assert.deepEqual(definitions.map(d => [d.kind, d.name]), [['program', 'real'], ['local', 'real'], ['program', 'short'], ['label', 'yesno']]);
    for (const definition of definitions) { assert.equal(text.slice(definition.start, definition.start + definition.name.length), definition.name); }
    assert.equal(definitions[0].end, text.indexOf('\nend\nprogram') + 4);
    assert.equal(visibleMacros(definitions, text.length).length, 0);
    assert.equal(macroReferenceAt('use "${root}/`file\'"', 9).name, 'root');
});

test('sections accept numbered, decorated, capitals and bookmarks, skipping separator-only comments', () => {
    for (const line of ['* 1. Title', '* 1.2. Subsection', '* --- Title ---', '* ALL CAPS', '**# Bookmark', '**## Nested']) {
        assert.ok(detectSection(line), line);
    }
    for (const line of ['* --------', '* =======', '**# ------', '* normal comment', '* 12345']) {
        assert.equal(detectSection(line), undefined, line);
    }
    assert.deepEqual(detectSection('**## Nested'), { title: 'Nested', level: 2 });
    assert.ok(detectSection('* Mixed case', true));
});

test('outline ranges contain children, program drops remain distinct and loops nest', () => {
    const text = '**# Section\ncapture program drop helper\npr de helper, rclass\nforeach v of varlist x y {\nforvalues i = 1/2 {\ndisplay `v\'\n}\n}\nend\n**# Next\n* --------';
    const symbols = buildOutline(text);
    assert.deepEqual(symbols.map(s => s.name), ['Section', 'Next']);
    const [drop, program] = symbols[0].children;
    assert.equal(drop.kind, 'drop');
    assert.equal(program.name, 'helper');
    assert.equal(program.children[0].kind, 'loop');
    assert.equal(program.children[0].children[0].kind, 'loop');
    function validate(symbol) {
        assert.ok(symbol.start <= symbol.selectionStart && symbol.selectionEnd <= symbol.end, symbol.name);
        for (const child of symbol.children) {
            assert.ok(child.start >= symbol.start && child.end <= symbol.end, child.name);
            validate(child);
        }
    }
    symbols.forEach(validate);
    assert.equal(buildOutline('/*\n* ALL CAPS\n*/').length, 0);
});

test('semicolon star comments end at a semicolon and block comments join command lines', () => {
    const text = '#delimit ;\n* use fake; use real;\n* multi\nline comment;\ndo task;\n#delimit cr\nimport delimited /* outer\n/* inner */\n*/ using "data.csv"';
    assert.deepEqual(links(text, ['/project/fake.dta', '/project/real.dta', '/project/task.do', '/project/data.csv']).map(l => l.target), [
        '/project/real.dta', '/project/task.do', '/project/data.csv',
    ]);
});

test('links within programs use isolated paths and support use-varlist-using syntax', () => {
    const text = 'program helper\nglobal root "/other"\ncd "$root"\nuse x y using "data"\nend\nuse data';
    assert.deepEqual(links(text, ['/other', '/other/data.dta', '/project/data.dta']).map(l => l.target), [
        '/other', '/other/data.dta', '/project/data.dta',
    ]);
});

test('loop macro braces do not truncate outline ranges, and program sections stay inside the program', () => {
    const text = 'program helper\n**# Within program\nforeach v in ${variables} {\ndisplay `v\'\n}\nend\n**# Outside';
    const outline = buildOutline(text);
    assert.equal(outline[0].kind, 'program');
    assert.equal(outline[0].children[0].name, 'Within program');
    const loop = outline[0].children[0].children[0];
    assert.equal(loop.name, 'foreach v in ${variables}');
    assert.equal(text[loop.end - 1], '}');
    assert.equal(outline[1].name, 'Outside');
    const source = scanStata(text);
    assert.equal(visibleMacros(parseDefinitions(source), text.indexOf('display')).find(d => d.name === 'v').kind, 'local');
    assert.equal(scanStata('mata:\n* POINTER\nend').starComments.length, 0);
});
