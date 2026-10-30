const test = require('node:test');
const assert = require('node:assert/strict');

const {
    compareStataValues,
    detectNumericColumns,
    getStataMissingRank,
    isStataMissingToken,
    parseCsv,
    parseStrictNumber,
    prepareCsvTable,
} = require('../out/dataUtils.js');

test('parseCsv handles UTF-8 BOM, CRLF, escaped quotes, commas, and embedded newlines', () => {
    const csv = '\uFEFFmake,note,price\r\n'
        + '"AMC, Concord","Say ""hello""\r\nworld",4099\r\n'
        + '"Ford","Line 1\nLine 2",.\r\n';

    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.headers, ['make', 'note', 'price']);
    assert.equal(parsed.totalDataRows, 2);
    assert.deepEqual(parsed.rows, [
        ['AMC, Concord', 'Say "hello"\r\nworld', '4099'],
        ['Ford', 'Line 1\nLine 2', '.'],
    ]);
});

test('parseCsv preserves observations where all cells are empty strings in multi- and single-column datasets', () => {
    const multiCol = 'a,b\nfoo,bar\n,\nbaz,qux\n';
    const parsedMulti = parseCsv(multiCol);
    assert.equal(parsedMulti.totalDataRows, 3);
    assert.deepEqual(parsedMulti.rows[1], ['', '']);

    const singleCol = 'x\n1\n\n3\n';
    const parsedSingle = parseCsv(singleCol);
    assert.equal(parsedSingle.totalDataRows, 3);
    assert.deepEqual(parsedSingle.rows, [['1'], [''], ['3']]);
});

test('parseCsv enforces maxDataRows while still counting totalDataRows accurately', () => {
    const lines = ['id,label'];
    for (let i = 1; i <= 50; i++) {
        lines.push(`${i},"item\n${i}"`);
    }
    const parsed = parseCsv(lines.join('\r\n'), 10);
    assert.equal(parsed.rows.length, 10);
    assert.equal(parsed.totalDataRows, 50);
    assert.deepEqual(parsed.rows[9], ['10', 'item\n10']);
});

test('parseStrictNumber and detectNumericColumns reject partial numbers like ISO dates or IDs', () => {
    assert.equal(parseStrictNumber('42'), 42);
    assert.equal(parseStrictNumber('-3.14e-2'), -0.0314);
    assert.equal(parseStrictNumber('2026-10-29'), null);
    assert.equal(parseStrictNumber('123abc'), null);
    assert.equal(parseStrictNumber('.'), null);
    assert.equal(parseStrictNumber('.a'), null);

    const headers = ['price', 'date', 'make', 'ext_miss'];
    const rows = [
        ['4099', '2026-01-15', 'AMC', '.a'],
        ['', '2026-10-29', 'Buick', '12.5'],
        ['.', '2025-12-01', 'Ford', '.z'],
    ];
    assert.deepEqual(detectNumericColumns(headers, rows), [true, false, false, true]);
});

test('compareStataValues sorts numeric strings numerically and always places Stata missing values last', () => {
    assert.equal(isStataMissingToken('.'), true);
    assert.equal(isStataMissingToken('.a'), true);
    assert.equal(isStataMissingToken('.z'), true);
    assert.equal(isStataMissingToken('.A'), false);
    assert.ok(getStataMissingRank('.') < getStataMissingRank('.a'));
    assert.ok(getStataMissingRank('.a') < getStataMissingRank('.z'));

    const raw = ['10', '.', '.z', '-3.5', '2', '', '.a', '1e2'];
    const asc = raw.slice().sort((a, b) => compareStataValues(a, b, true));
    assert.deepEqual(asc, ['-3.5', '2', '10', '1e2', '', '.', '.a', '.z']);

    const desc = raw.slice().sort((a, b) => compareStataValues(a, b, false));
    assert.deepEqual(desc, ['1e2', '10', '2', '-3.5', '', '.', '.a', '.z']);
});

test('compareStataValues sorts strings and ISO dates properly without parseFloat prefix bugs', () => {
    const dates = ['2024-10-29', '.', '2024-02-01', '2023-12-31'];
    const asc = dates.slice().sort((a, b) => compareStataValues(a, b, true));
    assert.deepEqual(asc, ['2023-12-31', '2024-02-01', '2024-10-29', '.']);
});

test('prepareCsvTable normalizes row widths and computes truncation metadata', () => {
    const csv = 'a,b,c\n1,2\n3,4,5,6\n7,8,9\n';
    const table = prepareCsvTable(csv, 2, 100);
    assert.equal(table.showing, 2);
    assert.equal(table.total, 100);
    assert.equal(table.truncated, true);
    assert.deepEqual(table.rows, [
        ['1', '2', ''],
        ['3', '4', '5'],
    ]);
    assert.equal(table.shapeKey, 'a\u0000b\u0000c');
});

test('prepareCsvTable parses real Stata sysuse auto export delimited output when Stata is available', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');

    const stataBin = '/usr/local/bin/stata-mp';
    if (!fs.existsSync(stataBin)) {
        t.skip('Local stata-mp binary not present');
        return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-csv-test-'));
    const csvPath = path.join(tmpDir, 'auto.csv');
    try {
        const script = `sysuse auto, clear\nexport delimited using "${csvPath}", replace\n`;
        const proc = spawnSync(stataBin, ['-q'], { input: script, encoding: 'utf-8', timeout: 10000 });
        if (proc.status !== 0 || !fs.existsSync(csvPath)) {
            t.skip('Stata invocation did not produce CSV');
            return;
        }
        const content = fs.readFileSync(csvPath, 'utf-8');
        const table = prepareCsvTable(content, 10000, 74);
        assert.equal(table.showing, 74);
        assert.equal(table.total, 74);
        assert.equal(table.truncated, false);
        assert.equal(table.headers[0], 'make');
        assert.equal(table.headers[1], 'price');
        // make is string (false), price and mpg are numeric (true), foreign is value-labelled text ("Domestic"/"Foreign" -> false)
        assert.equal(table.numericCols[0], false);
        assert.equal(table.numericCols[1], true);
        assert.equal(table.numericCols[2], true);
        assert.equal(table.numericCols[table.headers.indexOf('foreign')], false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
