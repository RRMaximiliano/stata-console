const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createNonce,
    crossPlatformBasename,
    escapeHtml,
    escapeMarkdown,
    sanitizeExternalUrl,
    serializeJsonForHtml,
} = require('../out/htmlUtils.js');

const {
    buildHelpFileCandidates,
    deriveStataInstallRoots,
    parseHelpTarget,
    resolveBrowseTarget,
    smclToHtml,
} = require('../out/smclParser.js');

test('htmlUtils escapes HTML, Markdown, script-embedded JSON, and validates external URLs', () => {
    assert.equal(escapeHtml(`<img src="x" onerror='alert(1)&2'>`), '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&amp;2&#39;&gt;');
    assert.ok(escapeMarkdown('[click](command:evil)').includes('\\[click\\]'));

    const n1 = createNonce();
    const n2 = createNonce();
    assert.ok(n1.length >= 24);
    assert.notEqual(n1, n2);

    const json = serializeJsonForHtml({ cell: '</script><script>alert(1)</script>\u2028' });
    assert.equal(json.includes('</script>'), false);
    assert.equal(json.includes('\u2028'), false);
    assert.deepEqual(JSON.parse(json), { cell: '</script><script>alert(1)</script>\u2028' });

    assert.equal(sanitizeExternalUrl('https://www.stata.com/manuals18/r.pdf'), 'https://www.stata.com/manuals18/r.pdf');
    assert.equal(sanitizeExternalUrl('mailto:support@stata.com'), 'mailto:support@stata.com');
    assert.equal(sanitizeExternalUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeExternalUrl('command:stata.run'), null);
    assert.equal(sanitizeExternalUrl('vscode://file/etc/passwd'), null);
    assert.equal(sanitizeExternalUrl('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(sanitizeExternalUrl('file:///C:/Windows/System32/calc.exe'), null);

    assert.equal(crossPlatformBasename('C:\\Users\\alice\\data\\auto.dta'), 'auto.dta');
    assert.equal(crossPlatformBasename('/Users/alice/data/auto.dta'), 'auto.dta');
});

test('smclToHtml blocks HTML/XSS injection via {char}, {c}, {browse}, {marker}, and fileName', () => {
    const malicious = [
        '{smcl}',
        '{char 60}script{char 62}alert(1){char 60}/script{char 62}',
        '{c 60}img src=x onerror=alert(2){c 62}',
        '{browse "javascript:alert(3)":Evil JS}',
        '{browse "command:workbench.action.terminal.new":Evil Cmd}',
        '{marker "><script>alert(4)</script>}',
        '{title:<svg onload=alert(5)>}',
    ].join('\r\n');

    const html = smclToHtml(malicious, '<img onerror=alert(6)>.sthlp', {
        nonce: 'testNonce123',
        cspSource: 'vscode-webview://origin',
    });

    assert.equal(html.includes('<script>alert'), false);
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<svg onload'), false);
    assert.equal(html.includes('href="javascript:'), false);
    assert.equal(html.includes('href="command:'), false);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes("script-src 'nonce-testNonce123';"));
});

test('smclToHtml parses colons inside quoted URLs, help links, synopt tables, p2col blocks, and space directives', () => {
    const sample = [
        '{smcl}',
        '{viewerdialog "svy: regress" "dialog regress"}',
        '{findalias assemreg}',
        '{vieweralsosee "" "--"}',
        '{vieweralsosee "[BAYES] bayes: regress" "help bayes regress"}',
        '{viewerjumpto "Options" "regress##options"}',
        '{p2colset 1 16 18 2}{...}',
        '{p2col:{bf:[R] regress} {hline 2}}Linear regression{p_end}',
        '{p2colreset}{...}',
        'INCLUDE help myinc',
        '{synoptset 20 tabbed}{...}',
        '{synopthdr}',
        '{synopt :{opt nocons:tant}}suppress constant{p_end}',
        '{synopt :{opth ef:orm(strings:string)}}exponentiate{p_end}',
        '{synoptset}',
        '{pstd}Visit {browse "https://www.stata.com":Stata{space 2}Site} or see {help regress##options:options} and {manhelp bayes_regress BAYES:bayes: regress}.{p_end}',
    ].join('\r\n');

    const html = smclToHtml(sample, 'C:\\Stata18\\ado\\base\\r\\regress.sthlp', {
        includeResolver: (topic) => (topic === 'myinc' ? '{pstd}Included note.{p_end}' : undefined),
    });

    // Dialog and findalias metadata must not leak into body
    assert.equal(html.includes('dialog regress'), false);
    assert.equal(html.includes('assemreg'), false);
    // Separator "--" excluded from Also See, while real entry with colon inside quotes is preserved
    assert.equal(html.includes('title="--"'), false);
    assert.ok(html.includes('[BAYES] bayes: regress'));
    assert.ok(html.includes('data-help="bayes_regress"'));
    // Quoted https:// URL with colon parsed properly
    assert.ok(html.includes('href="https://www.stata.com"'));
    // {space 2} renders horizontal non-breaking spaces, not <br>
    assert.ok(html.includes('Stata&nbsp;&nbsp;Site'));
    // {opt nocons:tant} underlines abbreviation without literal colon
    assert.ok(html.includes('<span class="smcl-ul">nocons</span>tant'));
    // {p2col} and {synopt} blocks close cleanly
    assert.ok(html.includes('Linear regression</div></div>'));
    assert.ok(html.includes('suppress constant</td></tr>'));
    // INCLUDE expansion worked
    assert.ok(html.includes('Included note.'));
    // Header title extracted cleanly from Windows path
    assert.ok(html.includes('<span class="smcl-header-title">regress</span>'));
});

test('Windows and POSIX path helpers resolve help topics safely and block path traversal or executables', () => {
    assert.equal(parseHelpTarget('../../etc/passwd'), null);
    assert.equal(parseHelpTarget('..\\..\\Windows\\win.ini'), null);
    assert.deepEqual(parseHelpTarget('help regress postestimation##plots'), {
        topic: 'regress_postestimation',
        anchor: 'plots',
    });

    const winCandidates = buildHelpFileCandidates('fvvarlist', {
        currentFilePath: 'C:\\Program Files\\Stata18\\ado\\base\\r\\regress.sthlp',
        pathImpl: path.win32,
    });
    assert.ok(winCandidates.includes('C:\\Program Files\\Stata18\\ado\\base\\f\\fvvarlist.sthlp'));

    const winRoots = deriveStataInstallRoots('C:\\Program Files\\Stata18\\StataMP-64.exe', path.win32);
    assert.ok(winRoots.includes('C:\\Program Files\\Stata18'));

    const macRoots = deriveStataInstallRoots('/Applications/StataNow/StataMP.app/Contents/MacOS/stata-mp', path.posix);
    assert.ok(macRoots.includes('/Applications/StataNow'));

    // Safe relative .do file on Windows allowed; .exe / .bat blocked
    const safeLocal = resolveBrowseTarget(
        'examples\\demo.do',
        'C:\\Users\\alice\\pkg\\mycmd.sthlp',
        path.win32,
    );
    assert.deepEqual(safeLocal, {
        kind: 'localFile',
        filePath: 'C:\\Users\\alice\\pkg\\examples\\demo.do',
    });

    const blockedExe = resolveBrowseTarget(
        'C:\\Windows\\System32\\cmd.exe',
        'C:\\Users\\alice\\pkg\\mycmd.sthlp',
        path.win32,
    );
    assert.deepEqual(blockedExe, { kind: 'blocked' });
});

test('smclToHtml renders real Stata regress.sthlp cleanly when installed locally', (t) => {
    const realSthlp = '/Applications/StataNow/ado/base/r/regress.sthlp';
    if (!fs.existsSync(realSthlp)) {
        t.skip('Local Stata help file not present');
        return;
    }
    const raw = fs.readFileSync(realSthlp, 'utf-8');
    const html = smclToHtml(raw, realSthlp);
    assert.equal(html.includes('dialog regress, message(-svy-)'), false);
    assert.ok(html.includes('id="syntax"'));
    assert.ok(html.includes('id="options"'));
    const openTables = (html.match(/<table\b/g) || []).length;
    const closeTables = (html.match(/<\/table>/g) || []).length;
    assert.equal(openTables, closeTables);
});
