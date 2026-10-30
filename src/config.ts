import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import {
    type ResolverEnvironment,
    type StataPathDiagnostics,
    getStataPathDiagnostics as getResolverDiagnostics,
    getStataPathHelp as getResolverHelp,
    resolveStataPath,
    resolveConfiguredPath,
    resolveStataInstallDir,
    editionFromExecutable,
    expandUserPath,
    editionOrder,
} from './stataPathResolver';
import type { BackendKind, StataBackend } from './backend';
import { ConsoleBackend } from './stataProcess';
import { PyStataBackend } from './pystataBackend';

function createResolverEnvironment(): ResolverEnvironment {
    return {
        platform: os.platform(),
        homeDir: os.homedir(),
        isFile(filePath: string): boolean {
            try {
                return fs.statSync(filePath).isFile();
            } catch {
                return false;
            }
        },
        isDirectory(dirPath: string): boolean {
            try {
                return fs.statSync(dirPath).isDirectory();
            } catch {
                return false;
            }
        },
        listDir(dirPath: string): string[] {
            try {
                return fs.readdirSync(dirPath);
            } catch {
                return [];
            }
        },
        realpath(filePath: string): string | undefined {
            try {
                return fs.realpathSync(filePath);
            } catch {
                return undefined;
            }
        },
        execFile(command: string, args: string[]): string | undefined {
            try {
                return execFileSync(command, args, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 3000,
                    windowsHide: true,
                });
            } catch {
                return undefined;
            }
        },
    };
}

export type { StataPathDiagnostics };

export function getStataPathHelp(): string {
    return getResolverHelp(os.platform());
}

export function getStataPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('stata');
    const edition = config.get<string>('stataEdition', 'MP');
    const userPath = config.get<string>('stataPath', '');
    const env = createResolverEnvironment();

    if (userPath.trim() !== '') {
        const resolvedUserPath = resolveConfiguredPath(userPath, edition, env);
        if (resolvedUserPath) {
            return resolvedUserPath;
        }
        vscode.window.showErrorMessage(`Configured Stata path is not a valid executable: ${userPath}`);
        return undefined;
    }

    return resolveStataPath('', edition, env);
}

export function getStataPathDiagnostics(): StataPathDiagnostics {
    const config = vscode.workspace.getConfiguration('stata');
    return getResolverDiagnostics(
        config.get<string>('stataPath', ''),
        config.get<string>('stataEdition', 'MP'),
        createResolverEnvironment(),
    );
}

export interface BackendResolution {
    backend?: StataBackend;
    /** User-facing explanation when no backend could be created. */
    error?: string;
}

export interface PythonInterpreter {
    path: string;
    version: string;
    bits: number;
}

export interface PythonDiscovery {
    python?: PythonInterpreter;
    error?: string;
}

interface PythonExtensionApi {
    environments?: {
        getActiveEnvironmentPath?: () => { path: string } | undefined;
        resolveEnvironment?: (environment: { path: string }) => Promise<{
            executable?: { uri?: { fsPath: string } };
        } | undefined>;
    };
}

async function activePythonPath(): Promise<string | undefined> {
    try {
        const extension = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
        if (!extension) {
            return undefined;
        }
        const api = extension.isActive ? extension.exports : await extension.activate();
        const environments = api?.environments;
        if (typeof environments?.getActiveEnvironmentPath !== 'function'
            || typeof environments.resolveEnvironment !== 'function') {
            return undefined;
        }
        const active = environments.getActiveEnvironmentPath();
        if (!active) {
            return undefined;
        }
        const resolved = await environments.resolveEnvironment(active);
        return resolved?.executable?.uri?.fsPath;
    } catch {
        return undefined;
    }
}

async function probePython(command: string, args: string[]): Promise<PythonInterpreter | undefined> {
    const script = 'import json,sys,struct; print(json.dumps({"version":list(sys.version_info[:3]),"path":sys.executable,"bits":struct.calcsize("P")*8}))';
    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(command, [...args, '-c', script], {
                encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            }, (err, stdout) => err ? reject(err) : resolve(stdout));
        });
        const result = JSON.parse(stdout.trim());
        if (!Array.isArray(result.version) || result.version.length !== 3 || !result.version.every(Number.isInteger)
            || result.version[0] < 3 || (result.version[0] === 3 && result.version[1] < 8)
            || typeof result.path !== 'string' || !result.path || ![32, 64].includes(result.bits)) {
            return undefined;
        }
        return { path: result.path, version: result.version.join('.'), bits: result.bits };
    } catch {
        return undefined;
    }
}

/** Candidates are executable paths, never shell command strings. py is probed with -3. */
export async function discoverPython(
    configuredPath = '',
    platform = os.platform(),
    probe = probePython,
    activeEnvironment = activePythonPath,
): Promise<PythonDiscovery> {
    const check = async (candidate: string): Promise<PythonInterpreter | undefined> => {
        const name = candidate.replace(/\\/g, '/').split('/').pop() ?? '';
        const python = await probe(candidate, platform === 'win32' && /^py(?:\.exe)?$/i.test(name) ? ['-3'] : []);
        return python && (platform !== 'win32' || python.bits === 64) ? python : undefined;
    };
    if (configuredPath.trim()) {
        const python = await check(expandUserPath(configuredPath, os.homedir()));
        return python ? { python } : {
            error: `Configured Python could not run Python 3.8+${platform === 'win32' ? ' (64-bit required for Windows Stata)' : ''}: ${configuredPath}. Set stata.pythonPath to the Python executable, without arguments.`,
        };
    }
    let active: string | undefined;
    try {
        active = await activeEnvironment();
    } catch {
        // The Python extension is optional; discovery can continue on PATH.
    }
    const pathCandidates = platform === 'win32' ? ['py', 'python3', 'python'] : ['python3', 'python'];
    const candidates = [active, ...pathCandidates].filter((item): item is string => !!item);
    for (const candidate of new Set(candidates)) {
        const python = await check(candidate);
        if (python) {
            return { python };
        }
    }
    return { error: `Python not found. Install Python 3.8+${platform === 'win32' ? ' (64-bit)' : ''} and set stata.pythonPath, or select an interpreter in the VS Code Python extension.` };
}

export function backendChoice(setting: string, platform: NodeJS.Platform): BackendKind {
    return setting === 'pystata' || (setting === 'auto' && platform === 'win32') ? 'pystata' : 'console';
}

export interface BackendDiagnostics {
    configuredBackend: string;
    backend: BackendKind;
    installDir?: string;
    python?: PythonInterpreter;
    pystataExists: boolean;
    error?: string;
}

export async function getBackendDiagnostics(stataPath?: string): Promise<BackendDiagnostics> {
    const config = vscode.workspace.getConfiguration('stata');
    const env = createResolverEnvironment();
    const configuredBackend = config.get<string>('backend', 'auto');
    const backend = backendChoice(configuredBackend, env.platform);
    const configuredDir = config.get<string>('installDir', '').trim();
    const installDir = configuredDir ? expandUserPath(configuredDir, env.homeDir)
        : stataPath ? resolveStataInstallDir(stataPath, env) : undefined;
    const pystataExists = !!installDir && env.isDirectory(path.join(installDir, 'utilities', 'pystata'));
    const discovery = await discoverPython(config.get<string>('pythonPath', ''));
    return { configuredBackend, backend, installDir, pystataExists, ...discovery };
}

/**
 * First detected Stata whose install has PyStata (17+), so an older Stata on
 * PATH or in Program Files does not shadow a newer one.
 */
function findPyStataCapable(edition: string, env: ResolverEnvironment): string | undefined {
    const diagnostics = getResolverDiagnostics('', edition, env);
    return [...diagnostics.pathMatches, ...diagnostics.existingCandidates].find((candidate) => {
        const dir = resolveStataInstallDir(candidate, env);
        return !!dir && env.isDirectory(path.join(dir, 'utilities', 'pystata'));
    });
}

/**
 * Pick and construct the backend for a new console session.
 * Async because Python discovery (for PyStata) may query other extensions.
 */
export async function resolveBackend(): Promise<BackendResolution> {
    const config = vscode.workspace.getConfiguration('stata');
    const env = createResolverEnvironment();
    const backend = backendChoice(config.get<string>('backend', 'auto'), env.platform);
    if (backend === 'console' && env.platform === 'win32') {
        return { error: 'The console backend is unavailable on Windows. Set stata.backend to auto or pystata; Stata 17+ is required for Windows.' };
    }
    const userPath = config.get<string>('stataPath', '').trim();
    const edition = config.get<string>('stataEdition', 'MP');
    const configuredDir = config.get<string>('installDir', '').trim();
    const stataPath = userPath ? resolveConfiguredPath(userPath, edition, env)
        : backend === 'pystata' && configuredDir ? resolveConfiguredPath(expandUserPath(configuredDir, env.homeDir), edition, env)
        : backend === 'pystata' ? findPyStataCapable(edition, env) ?? resolveStataPath('', edition, env)
        : resolveStataPath('', edition, env);
    if (userPath && !stataPath) {
        return { error: `Configured Stata path is not a valid executable: ${userPath}. Correct stata.stataPath or leave it empty for auto-detection.` };
    }
    if (backend === 'console') {
        return stataPath ? { backend: new ConsoleBackend(stataPath) } : { error: getStataPathHelp() };
    }
    const installDir = configuredDir ? expandUserPath(configuredDir, env.homeDir)
        : stataPath ? resolveStataInstallDir(stataPath, env) : undefined;
    if (!installDir || !env.isDirectory(path.join(installDir, 'utilities', 'pystata'))) {
        return { error: `${env.platform === 'win32' ? 'Stata 17+ required for Windows.' : 'PyStata requires Stata 17+.'} Could not find utilities/pystata${installDir ? ` in ${installDir}` : ''}. Set stata.installDir to the Stata installation directory (not the .app or executable).` };
    }
    const { python, error } = await discoverPython(config.get<string>('pythonPath', ''));
    if (!python) {
        return { error };
    }
    const actualPath = stataPath ? env.realpath(stataPath) ?? stataPath : undefined;
    const detectedEdition = actualPath ? editionFromExecutable(actualPath) : undefined;
    return { backend: new PyStataBackend({
        pythonPath: python.path,
        stataDir: installDir,
        edition: detectedEdition ?? editionOrder(edition)[0],
    }) };
}
