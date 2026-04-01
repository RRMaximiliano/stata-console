export type StataEdition = 'mp' | 'se' | 'be';

export interface ResolverEnvironment {
    platform: NodeJS.Platform;
    homeDir: string;
    isFile(path: string): boolean;
    isDirectory(path: string): boolean;
    listDir(path: string): string[];
    execFile(command: string, args: string[]): string | undefined;
}

export interface StataPathDiagnostics {
    platform: NodeJS.Platform;
    edition: string;
    configuredPath: string;
    resolvedConfiguredPath?: string;
    pathMatches: string[];
    existingCandidates: string[];
    selectedPath?: string;
    helpMessage: string;
}

export function editionOrder(edition?: string): StataEdition[] {
    return edition === 'SE' ? ['se', 'mp', 'be']
        : edition === 'BE' ? ['be', 'se', 'mp']
        : ['mp', 'se', 'be'];
}

export function binaryNames(edition?: string): string[] {
    const names: string[] = [];
    for (const ed of editionOrder(edition)) {
        names.push(`stata-${ed}`);
    }
    names.push('stata');
    return Array.from(new Set(names));
}

export function expandUserPath(inputPath: string, homeDir: string): string {
    const trimmed = inputPath.trim();
    if (trimmed === '~') {
        return homeDir;
    }
    if (trimmed.startsWith('~/')) {
        return homeDir + trimmed.slice(1);
    }
    return trimmed;
}

export function pathBasename(filePath: string): string {
    const normalized = filePath.replace(/\/+$/, '');
    const idx = normalized.lastIndexOf('/');
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function appBundleExecutableCandidates(appPath: string, edition?: string): string[] {
    const appBase = pathBasename(appPath).toLowerCase();
    const appSpecific = appBase.includes('statamp') ? ['stata-mp']
        : appBase.includes('statase') ? ['stata-se']
        : appBase.includes('statabe') ? ['stata-be']
        : appBase === 'stata.app' ? ['stata']
        : [];
    const names = appSpecific.length > 0 ? appSpecific : binaryNames(edition);
    return names.map((name) => `${appPath}/Contents/MacOS/${name}`);
}

function existingExecutable(paths: string[], env: ResolverEnvironment): string | undefined {
    for (const candidate of paths) {
        if (env.isFile(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

export function resolveConfiguredPath(
    configuredPath: string,
    edition: string | undefined,
    env: ResolverEnvironment,
): string | undefined {
    const normalized = expandUserPath(configuredPath, env.homeDir);

    if (env.isFile(normalized)) {
        return normalized;
    }

    if (env.platform === 'darwin' && env.isDirectory(normalized)) {
        if (normalized.endsWith('.app')) {
            return existingExecutable(appBundleExecutableCandidates(normalized, edition), env);
        }

        if (normalized.endsWith('/Contents/MacOS')) {
            return existingExecutable(binaryNames(edition).map((name) => `${normalized}/${name}`), env);
        }

        return existingExecutable(binaryNames(edition).map((name) => `${normalized}/${name}`), env);
    }

    if (env.isDirectory(normalized)) {
        return existingExecutable(binaryNames(edition).map((name) => `${normalized}/${name}`), env);
    }

    return undefined;
}

export function findExecutablesOnPath(
    edition: string | undefined,
    env: ResolverEnvironment,
): string[] {
    const matches: string[] = [];
    for (const name of binaryNames(edition)) {
        const resolved = env.execFile('which', [name])?.trim();
        if (resolved && env.isFile(resolved)) {
            matches.push(resolved);
        }
    }
    return Array.from(new Set(matches));
}

export function buildSearchPaths(
    edition: string | undefined,
    env: ResolverEnvironment,
): string[] {
    const paths = new Set<string>();

    if (env.platform === 'darwin') {
        const macDirs = ['/Applications/StataNow', '/Applications/Stata'];
        const appNames: Record<StataEdition, string[]> = {
            mp: ['StataMP.app', 'StataMPM1.app'],
            se: ['StataSE.app'],
            be: ['StataBE.app', 'Stata.app'],
        };

        for (const ed of editionOrder(edition)) {
            for (const dir of macDirs) {
                for (const appName of appNames[ed]) {
                    for (const candidate of appBundleExecutableCandidates(`${dir}/${appName}`, edition)) {
                        paths.add(candidate);
                    }
                }
            }
        }

        for (const binDir of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
            for (const name of binaryNames(edition)) {
                paths.add(`${binDir}/${name}`);
            }
        }

        const appResults = env.execFile('mdfind', [
            'kMDItemContentType == "com.apple.application-bundle" && (kMDItemFSName == "StataMP.app" || kMDItemFSName == "StataMPM1.app" || kMDItemFSName == "StataSE.app" || kMDItemFSName == "StataBE.app" || kMDItemFSName == "Stata.app")',
        ]);
        if (appResults) {
            for (const appPath of appResults.split('\n').map((line) => line.trim()).filter(Boolean)) {
                for (const candidate of appBundleExecutableCandidates(appPath, edition)) {
                    paths.add(candidate);
                }
            }
        }
    }

    if (env.platform === 'linux') {
        for (const binDir of ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin']) {
            for (const name of binaryNames(edition)) {
                paths.add(`${binDir}/${name}`);
            }
        }

        for (const root of ['/usr/local', '/opt']) {
            for (const entry of env.listDir(root)) {
                if (!/^stata/i.test(entry)) {
                    continue;
                }
                const fullPath = `${root}/${entry}`;
                if (!env.isDirectory(fullPath)) {
                    continue;
                }
                for (const name of binaryNames(edition)) {
                    paths.add(`${fullPath}/${name}`);
                    paths.add(`${fullPath}/bin/${name}`);
                }
            }
        }
    }

    return Array.from(paths);
}

export function getStataPathHelp(platform: NodeJS.Platform): string {
    if (platform === 'darwin') {
        return 'Auto-detect could not find Stata(console). If Stata is installed, try opening the GUI app and choosing Stata > Install Terminal Utility..., or set "stata.stataPath" to the executable inside the app bundle, for example /Applications/Stata/StataMP.app/Contents/MacOS/stata-mp.';
    }
    if (platform === 'linux') {
        return 'Auto-detect could not find a Stata console binary. Set "stata.stataPath" to an executable such as stata-mp, stata-se, or the full install path.';
    }
    return 'This extension currently requires a Stata console executable. Set "stata.stataPath" manually.';
}

export function resolveStataPath(
    configuredPath: string,
    edition: string | undefined,
    env: ResolverEnvironment,
): string | undefined {
    const resolvedConfiguredPath = configuredPath
        ? resolveConfiguredPath(configuredPath, edition, env)
        : undefined;
    if (resolvedConfiguredPath) {
        return resolvedConfiguredPath;
    }

    const pathMatches = findExecutablesOnPath(edition, env);
    if (pathMatches.length > 0) {
        return pathMatches[0];
    }

    for (const candidate of buildSearchPaths(edition, env)) {
        if (env.isFile(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

export function getStataPathDiagnostics(
    configuredPath: string,
    edition: string | undefined,
    env: ResolverEnvironment,
): StataPathDiagnostics {
    const trimmedConfiguredPath = configuredPath.trim();
    const resolvedConfiguredPath = trimmedConfiguredPath
        ? resolveConfiguredPath(trimmedConfiguredPath, edition, env)
        : undefined;
    const pathMatches = findExecutablesOnPath(edition, env);
    const existingCandidates = buildSearchPaths(edition, env).filter((candidate) => env.isFile(candidate));
    const selectedPath = resolvedConfiguredPath ?? pathMatches[0] ?? existingCandidates[0];

    return {
        platform: env.platform,
        edition: edition || 'MP',
        configuredPath: trimmedConfiguredPath,
        resolvedConfiguredPath,
        pathMatches,
        existingCandidates,
        selectedPath,
        helpMessage: getStataPathHelp(env.platform),
    };
}
