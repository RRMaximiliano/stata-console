const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return { extensions: { getExtension: () => undefined } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
let discoverPython;
let backendChoice;
try {
    ({ discoverPython, backendChoice } = require('../out/config.js'));
} finally {
    Module._load = originalLoad;
}

const interpreter = { path: 'C:\\Python 3\\python.exe', version: '3.12.8', bits: 64 };

test('backend auto chooses PyStata only on Windows', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
        assert.equal(backendChoice('auto', platform), platform === 'win32' ? 'pystata' : 'console');
        assert.equal(backendChoice('pystata', platform), 'pystata');
        assert.equal(backendChoice('console', platform), 'console');
    }
});

test('Python setting wins and an invalid explicit setting returns an actionable error', async () => {
    const calls = [];
    const probe = async (command, args) => { calls.push([command, args]); return interpreter; };
    const active = async () => { throw new Error('must not query extension'); };
    assert.deepEqual(await discoverPython(interpreter.path, 'win32', probe, active), { python: interpreter });
    assert.deepEqual(calls, [[interpreter.path, []]]);
    const result = await discoverPython('/missing/python', 'linux', async () => undefined, active);
    assert.match(result.error, /Configured Python.*3\.8\+.*stata\.pythonPath/);
});

test('active environment precedes PATH candidates', async () => {
    const calls = [];
    const result = await discoverPython('', 'darwin', async (command) => {
        calls.push(command);
        return interpreter;
    }, async () => '/venv/bin/python');
    assert.equal(result.python, interpreter);
    assert.deepEqual(calls, ['/venv/bin/python']);
});

test('Windows probes py with -3 and falls back past invalid or 32-bit interpreters', async () => {
    const calls = [];
    const result = await discoverPython('', 'win32', async (command, args) => {
        calls.push([command, args]);
        if (command === 'python3') { return { ...interpreter, bits: 32 }; }
        return command === 'python' ? interpreter : undefined;
    }, async () => '/invalid/python');
    assert.equal(result.python, interpreter);
    assert.deepEqual(calls, [['/invalid/python', []], ['py', ['-3']], ['python3', []], ['python', []]]);
    assert.match((await discoverPython('py.exe', 'win32', async (_command, args) => {
        assert.deepEqual(args, ['-3']);
        return { ...interpreter, bits: 32 };
    })).error, /64-bit/);
});

test('missing or failing Python extension falls back to PATH and reports no interpreter', async () => {
    const calls = [];
    const result = await discoverPython('', 'linux', async (command) => {
        calls.push(command);
        return undefined;
    }, async () => { throw new Error('extension failed'); });
    assert.deepEqual(calls, ['python3', 'python']);
    assert.match(result.error, /Python not found.*stata\.pythonPath/);
    assert.match((await discoverPython('', 'linux', async () => undefined)).error, /Python not found/);
});
