const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyVariableKind,
    filterAndSortVariables,
    formatStoredResultValue,
    parseResultsTsv,
    parseVarsTsv,
} = require('../out/sidebarUtils.js');

test('parseVarsTsv parses CRLF/LF variables and tolerates truncated mid-write last lines', () => {
    assert.deepEqual(parseVarsTsv(''), []);
    assert.deepEqual(parseVarsTsv('name\ttype'), []);

    const midWrite = '\uFEFFname\ttype\tformat\tlabel\r\n'
        + 'price\tint\t%8.0gc\tPrice\r\n'
        + 'hire_date\tlong\t%td\tHire date\r\n'
        + 'make\tstr18\t%-18s\tMake and mod'; // unterminated last line (no trailing \n)

    const safeMidWrite = parseVarsTsv(midWrite, { dropUnterminatedLastLine: true });
    assert.equal(safeMidWrite.length, 2);
    assert.equal(safeMidWrite[0].name, 'price');
    assert.equal(safeMidWrite[1].name, 'hire_date');

    // Also skips structurally truncated lines lacking valid %format even if followed by newline
    const brokenLine = 'name\ttype\tformat\tlabel\nmpg\tint\t%8.0g\tMileage\ntruncated_var\tint\n';
    const parsedBroken = parseVarsTsv(brokenLine);
    assert.equal(parsedBroken.length, 1);
    assert.equal(parsedBroken[0].name, 'mpg');
});

test('classifyVariableKind distinguishes numeric, string, and %t date/time variables', () => {
    assert.equal(classifyVariableKind('int', '%8.0gc'), 'numeric');
    assert.equal(classifyVariableKind('double', '%10.0g'), 'numeric');
    assert.equal(classifyVariableKind('str18', '%-18s'), 'string');
    assert.equal(classifyVariableKind('strL', '%9s'), 'string');
    assert.equal(classifyVariableKind('long', '%td'), 'date');
    assert.equal(classifyVariableKind('double', '%tc'), 'date');
    assert.equal(classifyVariableKind('int', '%-tm'), 'date');
    assert.equal(classifyVariableKind('int', '%tq'), 'date');
});

test('filterAndSortVariables filters across fields and sorts by order, name, or type', () => {
    const vars = [
        { name: 'price', type: 'int', format: '%8.0gc', label: 'Vehicle price' },
        { name: 'make', type: 'str18', format: '%-18s', label: 'Make and model' },
        { name: 'adate', type: 'long', format: '%td', label: 'Sale date' },
    ];

    assert.deepEqual(
        filterAndSortVariables(vars, 'date', 'order').map((v) => v.name),
        ['adate'],
    );
    assert.deepEqual(
        filterAndSortVariables(vars, '', 'name').map((v) => v.name),
        ['adate', 'make', 'price'],
    );
    assert.deepEqual(
        filterAndSortVariables(vars, '', 'type').map((v) => v.name),
        ['price', 'adate', 'make'],
    );
});

test('parseResultsTsv groups e(), em, r(), and rm results and tolerates truncated last lines', () => {
    const tsv = [
        'type\tname\tvalue',
        'e\tN\t74',
        'e\tr2\t0.2195829',
        'em\tcmd\tregress',
        'em\tcohort\t2024 baseline sample',
        'r\tmean\t6165.2568',
        'r\tp\t0.000002345',
        'rm\tvarlist\tprice mpg',
        'r\tpartial_mid_write', // missing value tab and trailing newline
    ].join('\n');

    const groups = parseResultsTsv(tsv, { dropUnterminatedLastLine: true });
    assert.deepEqual(
        groups.map((g) => ({ id: g.id, label: g.label, count: g.items.length })),
        [
            { id: 'e_scalars', label: 'e() Scalars', count: 2 },
            { id: 'e_macros', label: 'e() Macros', count: 2 },
            { id: 'r_scalars', label: 'r() Scalars', count: 2 },
            { id: 'r_macros', label: 'r() Macros', count: 1 },
        ],
    );

    const cohortMacro = groups[1].items.find((i) => i.name === 'cohort');
    assert.equal(cohortMacro.accessor, 'e(cohort)');
    // Macro starting with digits must NOT be truncated to "2,024" by parseFloat
    assert.equal(cohortMacro.formattedValue, '2024 baseline sample');

    const rMean = groups[2].items.find((i) => i.name === 'mean');
    assert.equal(rMean.accessor, 'r(mean)');
    assert.equal(rMean.formattedValue, '6,165.26');

    const rP = groups[2].items.find((i) => i.name === 'p');
    assert.equal(rP.formattedValue, '2.345e-6');
});

test('formatStoredResultValue formats scalars cleanly without trailing-zero noise', () => {
    assert.equal(formatStoredResultValue('12500', true), '12,500');
    assert.equal(formatStoredResultValue('0.75', true), '0.75');
    assert.equal(formatStoredResultValue('0', true), '0');
    assert.equal(formatStoredResultValue('.', true), '.');
    assert.equal(formatStoredResultValue('.a', true), '.a');
    assert.equal(formatStoredResultValue('', false), '(empty)');
});
