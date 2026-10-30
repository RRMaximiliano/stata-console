const test = require('node:test');
const assert = require('node:assert/strict');

const {
    appBundleExecutableCandidates,
    buildSearchPaths,
    binaryNames,
    editionFromExecutable,
    expandUserPath,
    getStataPathDiagnostics,
    resolveConfiguredPath,
    resolveStataPath,
    resolveStataInstallDir,
} = require('../out/stataPathResolver.js');

function createEnv({
    platform = 'darwin',
    homeDir = '/Users/tester',
    files = [],
    directories = [],
    listings = {},
    exec = {},
    realpaths = {},
} = {}) {
    const fileSet = new Set(files);
    const dirSet = new Set(directories);

    return {
        platform,
        homeDir,
        isFile(filePath) {
            return fileSet.has(filePath);
        },
        isDirectory(dirPath) {
            return dirSet.has(dirPath);
        },
        listDir(dirPath) {
            return listings[dirPath] || [];
        },
        realpath(filePath) {
            return realpaths[filePath];
        },
        execFile(command, args) {
            return exec[`${command} ${args.join(' ')}`];
        },
    };
}

test('expandUserPath resolves home-relative paths', () => {
    assert.equal(expandUserPath('~/StataMP.app', '/Users/alice'), '/Users/alice/StataMP.app');
    assert.equal(expandUserPath('/Applications/Stata', '/Users/alice'), '/Applications/Stata');
    // Windows Explorer "Copy as path" adds quotes
    assert.equal(expandUserPath('"C:\\Program Files\\Stata19\\StataMP-64.exe"', 'C:\\Users\\a'), 'C:\\Program Files\\Stata19\\StataMP-64.exe');
});

test('app bundle candidates prefer the correct executable for edition-specific apps', () => {
    assert.deepEqual(
        appBundleExecutableCandidates('/Applications/Stata/StataMP.app', 'MP'),
        ['/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp'],
    );
});

test('resolveConfiguredPath accepts a macOS app bundle path', () => {
    const env = createEnv({
        files: ['/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp'],
        directories: ['/Applications/Stata/StataMP.app'],
    });

    assert.equal(
        resolveConfiguredPath('/Applications/Stata/StataMP.app', 'MP', env),
        '/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp',
    );
});

test('resolveStataPath prefers PATH matches before scanning install locations', () => {
    const env = createEnv({
        exec: {
            'which stata-mp': '/usr/local/bin/stata-mp',
        },
        files: [
            '/usr/local/bin/stata-mp',
            '/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp',
        ],
    });

    assert.equal(resolveStataPath('', 'MP', env), '/usr/local/bin/stata-mp');
});

test('buildSearchPaths discovers Spotlight app results on macOS', () => {
    const env = createEnv({
        exec: {
            'mdfind kMDItemContentType == "com.apple.application-bundle" && (kMDItemFSName == "StataMP.app" || kMDItemFSName == "StataMPM1.app" || kMDItemFSName == "StataSE.app" || kMDItemFSName == "StataBE.app" || kMDItemFSName == "Stata.app")': '/Applications/Custom/StataMP.app\n',
        },
    });

    const paths = buildSearchPaths('MP', env);
    assert.ok(paths.includes('/Applications/Custom/StataMP.app/Contents/MacOS/stata-mp'));
});

test('buildSearchPaths discovers Linux install directories under /opt', () => {
    const env = createEnv({
        platform: 'linux',
        directories: ['/opt/stata18'],
        listings: {
            '/usr/local': [],
            '/opt': ['stata18'],
        },
    });

    const paths = buildSearchPaths('MP', env);
    assert.ok(paths.includes('/opt/stata18/stata-mp'));
    assert.ok(paths.includes('/opt/stata18/bin/stata-mp'));
});

test('getStataPathDiagnostics reports configured and detected paths together', () => {
    const env = createEnv({
        files: [
            '/Applications/Stata/StataSE.app/Contents/MacOS/stata-se',
            '/usr/local/bin/stata-se',
        ],
        directories: ['/Applications/Stata/StataSE.app'],
        exec: {
            'which stata-se': '/usr/local/bin/stata-se',
        },
    });

    const diagnostics = getStataPathDiagnostics('/Applications/Stata/StataSE.app', 'SE', env);
    assert.equal(diagnostics.resolvedConfiguredPath, '/Applications/Stata/StataSE.app/Contents/MacOS/stata-se');
    assert.deepEqual(diagnostics.pathMatches, ['/usr/local/bin/stata-se']);
    assert.equal(diagnostics.selectedPath, '/Applications/Stata/StataSE.app/Contents/MacOS/stata-se');
});

test('Windows uses where, parses CRLF and skips missing matches', () => {
    const env = createEnv({
        platform: 'win32',
        files: ['D:\\Stata19\\StataSE-64.exe', 'C:\\Stata17\\StataSE-64.exe'],
        exec: {
            'where StataSE-64.exe': 'C:\\missing\\StataSE-64.exe\r\nD:\\Stata19\\StataSE-64.exe\r\nC:\\Stata17\\StataSE-64.exe\r\n',
        },
    });
    const diagnostics = getStataPathDiagnostics('', 'SE', env);
    assert.equal(diagnostics.selectedPath, 'D:\\Stata19\\StataSE-64.exe');
    assert.deepEqual(diagnostics.pathMatches, ['D:\\Stata19\\StataSE-64.exe', 'C:\\Stata17\\StataSE-64.exe']);
});

test('Windows resolves configured directories and prefers the requested edition', () => {
    const dir = 'C:\\Program Files\\Stata19';
    const env = createEnv({
        platform: 'win32',
        directories: [dir],
        files: [`${dir}\\StataMP-64.exe`, `${dir}\\StataSE-64.exe`],
    });
    assert.equal(resolveConfiguredPath(dir, 'SE', env), `${dir}\\StataSE-64.exe`);
    assert.equal(resolveConfiguredPath(`${dir}\\StataMP-64.exe`, 'SE', env), `${dir}\\StataMP-64.exe`);
});

test('Windows searches standard and enumerated installs on both Program Files roots', () => {
    const env = createEnv({
        platform: 'win32',
        homeDir: 'D:\\Users\\tester',
        directories: ['C:\\Program Files\\StataNow20', 'C:\\Program Files (x86)\\Stata16'],
        listings: {
            'C:\\Program Files': ['StataNow20', 'other'],
            'C:\\Program Files (x86)': ['Stata16'],
        },
        files: ['C:\\Program Files (x86)\\Stata16\\StataSE.exe'],
    });
    const paths = buildSearchPaths('MP', env);
    for (const version of ['Stata19', 'StataNow19', 'Stata18', 'Stata17']) {
        assert.ok(paths.includes(`C:\\Program Files\\${version}\\StataMP-64.exe`));
    }
    assert.ok(paths.includes('C:\\Program Files\\StataNow20\\StataMP-64.exe'));
    // installed folders are probed before the hard-coded names, newest first
    assert.ok(paths.indexOf('C:\\Program Files\\StataNow20\\StataMP-64.exe') < paths.indexOf('C:\\Program Files\\Stata19\\StataMP-64.exe'));
    assert.ok(paths.includes('D:\\Program Files\\Stata19\\StataMP-64.exe'));
    assert.equal(resolveStataPath('', 'SE', env), 'C:\\Program Files (x86)\\Stata16\\StataSE.exe');
});

test('Windows binary names include BE, unsuffixed, and older executables', () => {
    const names = binaryNames('BE', 'win32');
    assert.equal(names[0], 'StataBE-64.exe');
    for (const name of ['StataBE.exe', 'StataMP.exe', 'StataSE.exe', 'Stata-64.exe', 'Stata.exe']) {
        assert.ok(names.includes(name));
    }
});

test('edition detection handles Windows and Unix executables', () => {
    for (const [name, edition] of [
        ['C:\\Program Files\\Stata19\\StataMP-64.exe', 'mp'],
        ['StataSE.exe', 'se'], ['StataBE-64.EXE', 'be'], ['Stata-64.exe', 'be'],
        ['/opt/stata/stata-mp', 'mp'], ['/usr/bin/stata-se', 'se'], ['stata-be', 'be'], ['stata', 'be'],
        ['python.exe', undefined],
    ]) {
        assert.equal(editionFromExecutable(name), edition, name);
    }
});

test('install dir follows macOS terminal utility symlinks and app bundles', () => {
    const real = '/Applications/StataNow/StataMP.app/Contents/MacOS/stata-mp';
    const env = createEnv({ realpaths: { '/usr/local/bin/stata-mp': real } });
    assert.equal(resolveStataInstallDir('/usr/local/bin/stata-mp', env), '/Applications/StataNow');
    assert.equal(resolveStataInstallDir(real, env), '/Applications/StataNow');
});

test('install dir handles Windows, Linux executables and Linux bin subdirectories', () => {
    assert.equal(resolveStataInstallDir('C:\\Program Files\\Stata19\\StataMP-64.exe', createEnv({ platform: 'win32' })), 'C:\\Program Files\\Stata19');
    const env = createEnv({ platform: 'linux', directories: ['/opt/stata19/utilities/pystata'] });
    assert.equal(resolveStataInstallDir('/opt/stata19/stata-mp', env), '/opt/stata19');
    assert.equal(resolveStataInstallDir('/opt/stata19/bin/stata-mp', env), '/opt/stata19');
});

test('macOS install roots can be configured directly', () => {
    const executable = '/Applications/StataNow/StataSE.app/Contents/MacOS/stata-se';
    const env = createEnv({ directories: ['/Applications/StataNow'], files: [executable] });
    assert.equal(resolveConfiguredPath('/Applications/StataNow', 'SE', env), executable);
    assert.equal(expandUserPath('~\\Stata19', 'C:\\Users\\alice'), 'C:\\Users\\alice\\Stata19');
});
