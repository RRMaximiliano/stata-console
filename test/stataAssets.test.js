const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const grammar = JSON.parse(fs.readFileSync(path.join(root, 'syntaxes/stata.tmLanguage.json'), 'utf8'));
const language = JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8'));
const snippets = JSON.parse(fs.readFileSync(path.join(root, 'snippets/stata.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('grammar includes resolve and all regular expressions compile', () => {
    function visit(value) {
        if (!value || typeof value !== 'object') { return; }
        for (const [key, child] of Object.entries(value)) {
            if (key === 'include' && child.startsWith('#')) { assert.ok(grammar.repository[child.slice(1)], child); }
            if (['begin', 'end', 'match'].includes(key)) { assert.doesNotThrow(() => new RegExp(child), child); }
            visit(child);
        }
    }
    visit(grammar);
});

test('folding, indentation and macro word patterns accept Stata constructs', () => {
    const start = new RegExp(language.folding.markers.start);
    const end = new RegExp(language.folding.markers.end);
    const indent = new RegExp(language.indentationRules.increaseIndentPattern);
    for (const text of ['**# Section', 'pr de helper, rclass', 'foreach v in x y {', 'while x {', 'quietly {']) {
        assert.ok(start.test(text), text);
    }
    for (const text of ['capture program drop helper', 'program list', '* --------']) { assert.equal(start.test(text), false, text); }
    assert.ok(end.test('**# endregion'));
    assert.ok(end.test('end'));
    assert.ok(end.test('}'));
    assert.equal(indent.test('capture program drop helper'), false);
    assert.ok(indent.test('pr de helper, rclass'));
    assert.deepEqual('${root} $root `name\' i.age'.match(new RegExp(language.wordPattern, 'g')), ['${root}', '$root', '`name\'', 'i', 'age']);
    assert.ok(language.autoClosingPairs.some(pair => pair.open === '`' && pair.close === "'" && !pair.notIn.includes('string')));
});

test('snippets use portable editor paths and escape literal Stata globals', () => {
    const header = snippets['dofile-header'].body.join('\n');
    assert.match(header, /\$\{TM_DIRECTORY\}/);
    assert.match(header, /\\\$root\/data/);
    assert.doesNotMatch(JSON.stringify(snippets), /\/Users\/|C:\\\\Users\\\\/);
    assert.match(snippets.tempfile.body.join('\n'), /`\$\{1:tmp\}'/);
});

test('bindings are language scoped and ordinary terminal Ctrl+L remains available', () => {
    const bindings = manifest.contributes.keybindings;
    assert.ok(bindings.some(binding => binding.command === 'stata.runSelection' && binding.key === 'ctrl+enter' && binding.mac === 'cmd+enter'));
    assert.ok(bindings.some(binding => binding.command === 'stata.runSelection' && binding.key === 'shift+enter'));
    assert.equal(bindings.some(binding => binding.key === 'ctrl+shift+d' || binding.key === 'ctrl+d'), false);
    const clear = bindings.find(binding => binding.command === 'stata.clearConsole');
    assert.match(clear.when, /terminalFocus && stata.consoleActive/);
    assert.notEqual(clear.key, 'ctrl+l');
    for (const binding of bindings.filter(binding => ['stata.run', 'stata.runSelection'].includes(binding.command))) {
        assert.match(binding.when, /editorLangId == stata/);
        assert.match(binding.when, /resourceExtname != .sthlp/);
    }
});

// Set STATA_GRAMMAR_MODULES to a directory containing vscode-textmate and vscode-oniguruma.
// This optional engine check uses no extension runtime dependencies.
const grammarModules = process.env.STATA_GRAMMAR_MODULES;
test('TextMate tokenization handles nested syntax and semicolon statement comments', { skip: !grammarModules }, async () => {
    const tm = require(path.join(grammarModules, 'vscode-textmate'));
    const onig = require(path.join(grammarModules, 'vscode-oniguruma'));
    const wasm = fs.readFileSync(path.join(grammarModules, 'vscode-oniguruma/release/onig.wasm'));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new tm.Registry({
        onigLib: Promise.resolve({ createOnigScanner: patterns => new onig.OnigScanner(patterns), createOnigString: text => new onig.OnigString(text) }),
        loadGrammar: async () => grammar,
    });
    const loaded = await registry.loadGrammar('source.stata');
    function tokenize(lines) {
        let state = tm.INITIAL;
        return lines.map(line => {
            const result = loaded.tokenizeLine(line, state);
            state = result.ruleStack;
            return result.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes }));
        });
    }
    const scoped = (tokens, text, scope) => tokens.some(token => token.text.includes(text) && token.scopes.includes(scope));
    const nested = tokenize(['/* outer', '/* inner */', 'reg hidden', '*/', 'reg y x']);
    assert.ok(nested[2].every(token => token.scopes.includes('comment.block.stata')));
    assert.ok(scoped(nested[4], 'reg', 'support.function.statistics.stata'));
    const quotes = tokenize(['display `"outer `"inner"\' $root ${data} `a`b\'\'"\'', 'reg i.group##c.age', 'gen s = strtrim(substr(x, 1, 2))']);
    assert.ok(quotes[0].some(token => token.text === 'inner' && token.scopes.filter(scope => scope === 'string.quoted.compound.stata').length === 2));
    assert.ok(quotes[0].some(token => token.text === 'b' && token.scopes.filter(scope => scope === 'variable.other.local.stata').length === 2));
    assert.ok(scoped(quotes[0], '${data}', 'variable.other.global.stata'));
    assert.ok(scoped(quotes[1], '##', 'keyword.operator.factor.stata'));
    assert.ok(scoped(quotes[2], 'substr', 'support.function.string.stata'));
    const comments = tokenize(['/// continuation', '// comment', 'gen x = a * b']);
    assert.ok(scoped(comments[0], '///', 'comment.line.triple-slash.stata'));
    assert.ok(scoped(comments[1], '//', 'comment.line.double-slash.stata'));
    assert.ok(scoped(comments[2], '*', 'keyword.operator.arithmetic.stata'));
    const delimited = tokenize(['#delimit ;', '* first comment', 'still comment; gen x = a', '* b;', 'gen y = x; * same-line comment;', '#delimit cr', 'reg y x']);
    assert.ok(scoped(delimited[2], 'still comment', 'comment.line.star.stata'));
    assert.ok(scoped(delimited[3], '*', 'keyword.operator.arithmetic.stata'));
    assert.ok(scoped(delimited[4], 'same-line comment', 'comment.line.star.stata'));
    assert.ok(scoped(delimited[6], 'reg', 'support.function.statistics.stata'));
    const incomplete = tokenize(['display `unfinished', 'reg y x']);
    assert.ok(scoped(incomplete[1], 'reg', 'support.function.statistics.stata'));
    const numbers = tokenize(['gen x = .a', 'gen x = .', 'gen x = .25']);
    assert.ok(scoped(numbers[0], '.a', 'constant.language.missing.stata'));
    assert.ok(scoped(numbers[1], '.', 'constant.language.missing.stata'));
    assert.ok(scoped(numbers[2], '.25', 'constant.numeric.stata'));
    const mata = tokenize(['mata:', 'real matrix X', '* X', 'end', 'reg y x']);
    assert.ok(scoped(mata[1], 'real', 'storage.type.mata'));
    assert.ok(scoped(mata[2], '*', 'keyword.operator.arithmetic.stata'));
    assert.ok(scoped(mata[4], 'reg', 'support.function.statistics.stata'));
});
