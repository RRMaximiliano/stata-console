const test = require('node:test');
const assert = require('node:assert/strict');

const { LineEditor, parseInput } = require('../out/lineEditor.js');

const keys = (data) => parseInput(data).map((e) => (e.type === 'text' ? e.text : e.key));

test('plain typing is one text run', () => {
    assert.deepEqual(keys('summarize price'), ['summarize price']);
});

test('both Enter variants, including CRLF pastes, are single Enter presses', () => {
    assert.deepEqual(keys('a\rb'), ['a', 'enter', 'b']);
    assert.deepEqual(keys('a\r\nb\r\n'), ['a', 'enter', 'b', 'enter']);
    assert.deepEqual(keys('a\nb'), ['a', 'enter', 'b']);
});

test('multi-line paste yields one Enter per line', () => {
    assert.deepEqual(keys('forvalues i = 1/3 {\r\n  display `i\'\r\n}\r\n'), [
        'forvalues i = 1/3 {', 'enter', '  display `i\'', 'enter', '}', 'enter',
    ]);
});

test('both DEL and BS are backspace (Windows sends \\x7f or \\b)', () => {
    assert.deepEqual(keys('\x7f\b'), ['backspace', 'backspace']);
});

test('arrow, home/end, delete and control keys', () => {
    assert.deepEqual(keys('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
    assert.deepEqual(keys('\x1b[H\x1b[F\x1bOH\x1bOF\x1b[1~\x1b[4~'), ['home', 'end', 'home', 'end', 'home', 'end']);
    assert.deepEqual(keys('\x1b[3~'), ['delete']);
    assert.deepEqual(keys('\x01\x05\x15\x0b\x03'), ['home', 'end', 'kill-line', 'kill-to-end', 'interrupt']);
    assert.deepEqual(keys('\x1b[1;5C'), ['right']);
});

test('bracketed paste markers and unknown escapes are swallowed', () => {
    assert.deepEqual(keys('\x1b[200~ab\x1b[201~'), ['ab']);
    assert.deepEqual(keys('\x1b[15~x'), ['x']);
});

test('tabs become spaces so cursor math stays correct', () => {
    assert.deepEqual(keys('a\tb'), ['a    b']);
});

test('typing at the end echoes just the text; backspace erases one cell', () => {
    const ed = new LineEditor();
    assert.equal(ed.insert('abc'), 'abc');
    assert.equal(ed.backspace(), '\b \b');
    assert.equal(ed.text, 'ab');
});

test('editing mid-line redraws and keeps the cursor in place', () => {
    const ed = new LineEditor();
    ed.prompt = '. ';
    ed.insert('abcd');
    ed.left();
    ed.left();
    assert.equal(ed.insert('X'), '\r\x1b[2K. abXcd\x1b[2D');
    assert.equal(ed.text, 'abXcd');
    assert.equal(ed.backspace(), '\r\x1b[2K. abcd\x1b[2D');
    assert.equal(ed.delete(), '\r\x1b[2K. abd\x1b[1D');
    assert.equal(ed.text, 'abd');
});

test('home, end, kill-to-end, kill-line and kill-word', () => {
    const ed = new LineEditor();
    ed.prompt = '. ';
    ed.insert('one two three');
    assert.equal(ed.home(), '\x1b[13D');
    assert.equal(ed.end(), '\x1b[13C');
    ed.killWord();
    assert.equal(ed.text, 'one two ');
    ed.left();
    ed.left();
    ed.killToEnd();
    assert.equal(ed.text, 'one tw');
    ed.killLine();
    assert.equal(ed.text, '');
    assert.ok(ed.isEmpty);
});

test('cursor movement is clamped at both ends', () => {
    const ed = new LineEditor();
    assert.equal(ed.left(), '');
    assert.equal(ed.right(), '');
    assert.equal(ed.backspace(), '');
    assert.equal(ed.delete(), '');
    ed.insert('a');
    assert.equal(ed.right(), '');
    assert.equal(ed.left(), '\x1b[D');
    assert.equal(ed.left(), '');
});

test('set replaces the line for history recall', () => {
    const ed = new LineEditor();
    ed.prompt = '. ';
    ed.insert('x');
    assert.equal(ed.set('summarize'), '\r\x1b[2K. summarize');
    assert.equal(ed.text, 'summarize');
});
