import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
    type ResolverEnvironment,
    type StataPathDiagnostics,
    getStataPathDiagnostics as getResolverDiagnostics,
    getStataPathHelp as getResolverHelp,
    resolveStataPath,
    resolveConfiguredPath,
} from './stataPathResolver';

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
        execFile(command: string, args: string[]): string | undefined {
            try {
                return execFileSync(command, args, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'],
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
