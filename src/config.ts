import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';

type StataEdition = 'mp' | 'se' | 'be';

// Build search paths dynamically based on configured edition preference
function buildSearchPaths(edition?: string): string[] {
    // Edition priority: user preference first, then MP > SE > BE
    const editions: StataEdition[] =
        edition === 'SE' ? ['se', 'mp', 'be'] :
        edition === 'BE' ? ['be', 'se', 'mp'] :
        ['mp', 'se', 'be']; // default: MP first

    const paths: string[] = [];
    const platform = os.platform();

    if (platform === 'darwin') {
        // macOS paths — StataNow and classic installations
        const macDirs = ['/Applications/StataNow', '/Applications/Stata'];
        const appNames: Record<StataEdition, string[]> = {
            mp: ['StataMP.app/Contents/MacOS/stata-mp', 'StataMPM1.app/Contents/MacOS/stata-mp'],
            se: ['StataSE.app/Contents/MacOS/stata-se'],
            be: ['StataBE.app/Contents/MacOS/stata-be', 'Stata.app/Contents/MacOS/stata'],
        };
        for (const ed of editions) {
            for (const dir of macDirs) {
                for (const app of appNames[ed]) {
                    paths.push(`${dir}/${app}`);
                }
            }
        }
        // Homebrew / symlinks
        for (const ed of editions) {
            paths.push(`/usr/local/bin/stata-${ed}`);
        }
        paths.push('/usr/local/bin/stata');
    }

    if (platform === 'win32') {
        // Windows — Stata 14-19
        const versions = ['19', '18', '17', '16', '15', '14'];
        const winExe: Record<StataEdition, string[]> = {
            mp: ['StataMP-64.exe', 'StataMP.exe'],
            se: ['StataSE-64.exe', 'StataSE.exe'],
            be: ['StataBE-64.exe', 'Stata.exe'],
        };
        for (const ed of editions) {
            for (const ver of versions) {
                for (const exe of winExe[ed]) {
                    paths.push(`C:\\Program Files\\Stata${ver}\\${exe}`);
                    paths.push(`C:\\Program Files (x86)\\Stata${ver}\\${exe}`);
                }
            }
        }
    }

    if (platform === 'linux') {
        // Linux — /usr/local/stataNN/
        const versions = ['19', '18', '17', '16', '15', '14'];
        for (const ed of editions) {
            for (const ver of versions) {
                paths.push(`/usr/local/stata${ver}/stata-${ed}`);
            }
            paths.push(`/usr/local/stata/stata-${ed}`);
        }
        paths.push('/usr/local/stata/stata');
    }

    return paths;
}

export function getStataPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('stata');

    // 1. Explicit path override
    const userPath = config.get<string>('stataPath');
    if (userPath && userPath.trim() !== '') {
        if (fs.existsSync(userPath)) {
            return userPath;
        }
        vscode.window.showErrorMessage(`Configured Stata path not found: ${userPath}`);
        return undefined;
    }

    // 2. Auto-detect using edition preference
    const edition = config.get<string>('stataEdition', 'MP');
    const searchPaths = buildSearchPaths(edition);

    for (const candidate of searchPaths) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // 3. Try `which` on Unix-like systems
    if (os.platform() !== 'win32') {
        try {
            const { execSync } = require('child_process');
            const result = execSync(
                'which stata-mp 2>/dev/null || which stata-se 2>/dev/null || which stata 2>/dev/null',
                { encoding: 'utf-8' }
            ).trim();
            if (result && fs.existsSync(result)) {
                return result;
            }
        } catch { /* ignore */ }
    }

    return undefined;
}
