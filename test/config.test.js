const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function loadConfig({ platform = 'win32', settings = {}, extension, pythonResult, files = [], directories = [] } = {}) {
    const normalized = (file) => file.replace(/\\/g, '/');
    const fileSet = new Set(files.map(normalized));
    const dirSet = new Set(directories.map(normalized));
    const probes = [];
    const originalLoad = Module._load;
    const configPath = require.resolve('../out/config.js');
    delete require.cache[configPath];
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
                extensions: { getExtension: (id) => { assert.equal(id, 'ms-python.python'); return extension; } },
            };
        }
        if (request === 'os') {
            return { platform: () => platform, homedir: () => 'C:\\Users\\tester' };
        }
        if (request === 'fs') {
            return {
                statSync: (file) => ({ isFile: () => fileSet.has(normalized(file)), isDirectory: () => dirSet.has(normalized(file)) }),
                realpathSync: (file) => file,
                readdirSync: () => [],
            };
        }
        if (request === 'child_process') {
            return {
                execFileSync: () => '',
                execFile: (command, args, options, callback) => {
                    probes.push([command, args, options]);
                    callback(pythonResult ? null : new Error('not found'), pythonResult ? JSON.stringify(pythonResult) : '');
                    return new EventEmitter();
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return { config: require(configPath), probes };
    } finally {
        Module._load = originalLoad;
        delete require.cache[configPath];
    }
}

const python = { path: 'C:\\Python 3\\python.exe', version: [3, 12, 8], bits: 64 };
const installDir = 'C:\\Program Files\\Stata19';
const executable = `${installDir}\\StataSE-64.exe`;

test('auto backend resolves Windows Stata, Python and the detected executable edition', async () => {
    const { config } = loadConfig({
        settings: { stataPath: executable }, pythonResult: python,
        files: [executable], directories: [`${installDir}\\utilities\\pystata`],
    });
    const result = await config.resolveBackend();
    assert.equal(result.error, undefined);
    assert.equal(result.backend.kind, 'pystata');
    assert.equal(result.backend.options.edition, 'se');
    assert.equal(result.backend.options.stataDir, installDir);
    assert.equal(result.backend.options.pythonPath, python.path);
});

test('installDir override can construct PyStata without discovering an executable', async () => {
    const { config } = loadConfig({
        settings: { installDir, stataEdition: 'BE' }, pythonResult: python,
        directories: [installDir, `${installDir}\\utilities\\pystata`],
    });
    const result = await config.resolveBackend();
    assert.equal(result.backend.kind, 'pystata');
    assert.equal(result.backend.options.edition, 'be');
});

test('unrecognized executable names retain the configured edition', async () => {
    const custom = `${installDir}\\custom-stata.exe`;
    const { config } = loadConfig({
        settings: { stataPath: custom, stataEdition: 'SE' }, pythonResult: python,
        files: [custom], directories: [`${installDir}\\utilities\\pystata`],
    });
    assert.equal((await config.resolveBackend()).backend.options.edition, 'se');
});

test('backend resolution explains console-on-Windows, old Stata, bad overrides and missing Python', async () => {
    assert.match((await loadConfig({ settings: { backend: 'console' } }).config.resolveBackend()).error, /unavailable on Windows.*auto or pystata/);
    assert.match((await loadConfig().config.resolveBackend()).error, /Stata 17\+ required for Windows.*stata\.installDir/);
    assert.match((await loadConfig({ settings: { stataPath: 'missing.exe' } }).config.resolveBackend()).error, /Configured Stata path/);
    const base = { settings: { installDir }, directories: [`${installDir}\\utilities\\pystata`] };
    assert.match((await loadConfig(base).config.resolveBackend()).error, /Python not found.*stata\.pythonPath/);
    assert.match((await loadConfig({ ...base, pythonResult: { ...python, version: [3, 7, 9] } }).config.resolveBackend()).error, /Python not found/);
    assert.match((await loadConfig({ ...base, pythonResult: { ...python, bits: 32 } }).config.resolveBackend()).error, /64-bit/);
});

test('macOS auto retains the console backend', async () => {
    const { config, probes } = loadConfig({
        platform: 'darwin', settings: { stataPath: '/usr/local/bin/stata-mp' }, files: ['/usr/local/bin/stata-mp'],
    });
    assert.equal((await config.resolveBackend()).backend.kind, 'console');
    assert.deepEqual(probes, []);
});

test('Python discovery activates the optional extension and resolves its environment executable', async () => {
    const calls = [];
    const environment = { path: 'C:\\env', id: 'active' };
    const { config, probes } = loadConfig({
        pythonResult: python,
        extension: {
            isActive: false,
            activate: async () => {
                calls.push('activate');
                return { environments: {
                    getActiveEnvironmentPath: () => environment,
                    resolveEnvironment: async (active) => {
                        assert.equal(active, environment);
                        calls.push('resolve');
                        return { executable: { uri: { fsPath: python.path } } };
                    },
                } };
            },
        },
    });
    assert.equal((await config.discoverPython()).python.path, python.path);
    assert.deepEqual(calls, ['activate', 'resolve']);
    assert.equal(probes[0][0], python.path);
    assert.equal(probes[0][2].windowsHide, true);
});

test('absent, old, or failing Python extension APIs fall back safely', async () => {
    for (const extension of [
        undefined, { isActive: true, exports: {} },
        { isActive: false, activate: async () => { throw new Error('activation failure'); } },
        { isActive: true, exports: { environments: { getActiveEnvironmentPath: () => { throw new Error('API failure'); }, resolveEnvironment: async () => undefined } } },
    ]) {
        const { config, probes } = loadConfig({ extension, pythonResult: python });
        assert.equal((await config.discoverPython()).python.path, python.path);
        assert.equal(probes[0][0], 'py');
        assert.equal(probes[0][1][0], '-3');
    }
});

test('diagnostics report backend, install directory, PyStata and verified Python version', async () => {
    const { config } = loadConfig({ settings: { installDir }, pythonResult: python, directories: [`${installDir}\\utilities\\pystata`] });
    assert.deepEqual(await config.getBackendDiagnostics(), {
        configuredBackend: 'auto', backend: 'pystata', installDir, pystataExists: true,
        python: { path: python.path, version: '3.12.8', bits: 64 },
    });
});
