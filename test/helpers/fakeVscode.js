// Minimal stand-in for the `vscode` module so StataTerminal can run under node.
const Module = require('node:module');

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
        };
    }
    fire(value) {
        for (const l of [...this.listeners]) { l(value); }
    }
    dispose() {
        this.listeners = [];
    }
}

// Settings tests can override, keyed like `stata.browseRowLimit`.
const settings = {};

const fake = {
    EventEmitter,
    settings,
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                const full = `${section}.${key}`;
                return full in settings ? settings[full] : fallback;
            },
        }),
    },
};

function install() {
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') { return fake; }
        return originalLoad.call(this, request, ...rest);
    };
    return fake;
}

module.exports = { install, fake };
