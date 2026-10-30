const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
    constructor(start, end) { this.start = start; this.end = end; }
}
class Location {
    constructor(uri, range) { this.uri = uri; this.range = range; }
}
const files = new Map();
const requests = [];
let failOpen = false;
const vscode = {
    Position, Range, Location,
    CompletionItemKind: { Variable: 1, Keyword: 2, Function: 3, Field: 4 },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    MarkdownString: class {
        value = '';
        appendMarkdown(text) { this.value += text; }
        appendText(text) { this.value += text; }
        appendCodeblock(text) { this.value += text; }
    },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    workspace: {
        async findFiles(pattern, exclude, limit, token) {
            requests.push({ pattern, exclude, limit, token });
            if (token?.isCancellationRequested) { return []; }
            const exact = pattern.match(/^\*\*\/([a-zA-Z_]\w*)\.\{/);
            return [...files.values()].filter(doc => !exact || doc.uri.fsPath.endsWith(`/${exact[1]}.ado`) || doc.uri.fsPath.endsWith(`/${exact[1]}.do`)).slice(0, limit).map(doc => doc.uri);
        },
        async openTextDocument(uri) {
            if (failOpen) { throw new Error('deleted'); }
            return files.get(uri.toString());
        },
    },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest);
};
const { StataDefinitionProvider } = require('../out/definitionProvider.js');
const { StataCompletionProvider } = require('../out/completionProvider.js');
const { StataHoverProvider } = require('../out/hoverProvider.js');
Module._load = originalLoad;

function document(text, filename = '/project/main.do', version = 1) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i + 1); } }
    const doc = {
        version,
        uri: { fsPath: filename, scheme: 'file', toString() { return `file://${filename}`; } },
        getText(range) { return range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text; },
        offsetAt(position) { return starts[position.line] + position.character; },
        positionAt(offset) {
            let line = starts.findIndex(start => start > offset) - 1;
            if (line < 0) { line = starts.length - 1; }
            return new Position(line, offset - starts[line]);
        },
        getWordRangeAtPosition(position) {
            const offset = doc.offsetAt(position);
            const match = [...text.matchAll(/[a-zA-Z_]\w*/g)].find(m => offset >= m.index && offset <= m.index + m[0].length);
            return match ? new Range(doc.positionAt(match.index), doc.positionAt(match.index + match[0].length)) : undefined;
        },
    };
    return doc;
}

function reset() { files.clear(); requests.length = 0; failOpen = false; }

test('definition searches exact ado filename first and uses the correct name occurrence', async () => {
    reset();
    const target = document('program define define, rclass\nend', '/project/define.ado');
    files.set(target.uri.toString(), target);
    const result = await new StataDefinitionProvider().provideDefinition(document('define'), new Position(0, 3));
    assert.equal(result.length, 1);
    assert.equal(result[0].uri, target.uri);
    assert.equal(result[0].range.start.character, 15);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pattern, '**/define.{do,ado}');
});

test('definition finds programs in other workspace filenames, then refreshes edited documents', async () => {
    reset();
    const target = document('/* program fake */\npr de helper, rclass\nend', '/project/utilities.do');
    files.set(target.uri.toString(), target);
    const provider = new StataDefinitionProvider();
    const source = document('helper');
    const result = await provider.provideDefinition(source, new Position(0, 3));
    assert.equal(result[0].uri, target.uri);
    assert.equal(result[0].range.start.line, 1);
    assert.equal(requests[1].limit, 500);
    assert.match(requests[1].exclude, /node_modules/);
    const replacement = document('program other\nend', '/project/utilities.do', 2);
    files.set(replacement.uri.toString(), replacement);
    assert.equal(await provider.provideDefinition(source, new Position(0, 3)), undefined);
});

test('current-file macros and programs avoid workspace I/O; comments and strings do too', async () => {
    reset();
    const provider = new StataDefinitionProvider();
    const macro = document('local path "data"\ndisplay "`path\'"');
    const found = await provider.provideDefinition(macro, new Position(1, 12));
    assert.equal(found.range.start.line, 0);
    const program = document('program helper\nend\nhelper');
    assert.equal((await provider.provideDefinition(program, new Position(2, 3))).range.start.line, 0);
    assert.equal(await provider.provideDefinition(document('* helper'), new Position(0, 4)), undefined);
    assert.equal(await provider.provideDefinition(document('display "helper"'), new Position(0, 12)), undefined);
    assert.equal(requests.length, 0);
});

test('workspace definitions honor cancellation and tolerate deleted files', async () => {
    reset();
    const provider = new StataDefinitionProvider();
    const source = document('helper');
    assert.equal(await provider.provideDefinition(source, new Position(0, 3), { isCancellationRequested: true }), undefined);
    assert.equal(requests.length, 0);
    const deleted = document('program helper\nend', '/project/helper.ado');
    files.set(deleted.uri.toString(), deleted);
    failOpen = true;
    assert.equal(await provider.provideDefinition(source, new Position(0, 3)), undefined);
});

test('completion supports optional dataset variables and replaces entire macro references', () => {
    const provider = new StataCompletionProvider(() => ['wage', 'age', 'bad name']);
    const variables = provider.provideCompletionItems(document('reg '), new Position(0, 4));
    assert.deepEqual(variables.map(v => v.label), ['wage', 'age']);
    const macro = document('global root "C:/data"\nuse "${ro}"');
    const suggestions = provider.provideCompletionItems(macro, new Position(1, 9));
    assert.equal(suggestions[0].insertText, '${root}');
    assert.equal(macro.getText(suggestions[0].range), '${ro}');
    assert.deepEqual(provider.provideCompletionItems(document('// reg'), new Position(0, 6)), []);
    assert.ok(provider.provideCompletionItems(document('reg'), new Position(0, 3)).some(c => c.label === 'regress'));
});

test('hover resolves abbreviations and macro values without command hovers in strings/comments', () => {
    const provider = new StataHoverProvider();
    const reg = provider.provideHover(document('reg y x'), new Position(0, 2));
    assert.match(reg.contents.value, /regress/);
    const local = document('local outcome wage\ndisplay "`outcome\'"');
    assert.match(provider.provideHover(local, new Position(1, 12)).contents.value, /wage/);
    assert.equal(provider.provideHover(document('* reg'), new Position(0, 3)), undefined);
    assert.equal(provider.provideHover(document('display "reg"'), new Position(0, 11)), undefined);
});
