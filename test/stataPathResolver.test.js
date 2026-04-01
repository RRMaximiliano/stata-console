const test = require('node:test');
const assert = require('node:assert/strict');

const {
    appBundleExecutableCandidates,
    buildSearchPaths,
    expandUserPath,
    getStataPathDiagnostics,
    resolveConfiguredPath,
    resolveStataPath,
} = require('../out/stataPathResolver.js');

function createEnv({
    platform = 'darwin',
    homeDir = '/Users/tester',
    files = [],
    directories = [],
    listings = {},
    exec = {},
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
        execFile(command, args) {
            return exec[`${command} ${args.join(' ')}`];
        },
    };
}

test('expandUserPath resolves home-relative paths', () => {
    assert.equal(expandUserPath('~/StataMP.app', '/Users/alice'), '/Users/alice/StataMP.app');
    assert.equal(expandUserPath('/Applications/Stata', '/Users/alice'), '/Applications/Stata');
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
