import * as path from 'path';
import { parseDefinitions, scanStata, stripPrefixes } from './stataSyntax';

export interface StataFileReference {
    start: number;
    end: number;
    path: string;
    extension?: string;
    directory: boolean;
}

export interface ResolvedStataLink extends StataFileReference {
    target: string;
}

export function pathFlavor(value: string): typeof path.win32 {
    return /^[a-z]:|^[\\/]{2}[^/\\]/i.test(value) ? path.win32 : path.posix;
}

function readPath(text: string, start: number, rest: boolean): { value: string; start: number; end: number } | undefined {
    start += text.slice(start).match(/^\s*/)?.[0].length ?? 0;
    const compound = text.slice(start, start + 2) === '`"';
    const quoted = compound || text[start] === '"';
    const contentStart = start + (compound ? 2 : quoted ? 1 : 0);
    let end: number;
    if (quoted) {
        end = text.indexOf(compound ? '"\'' : '"', contentStart);
        if (end < 0) { return undefined; }
    } else {
        const tail = text.slice(start);
        const stop = tail.search(rest ? /[,\r\n]/ : /[\s,]/);
        end = start + (stop < 0 ? tail.length : stop);
        while (end > contentStart && /\s/.test(text[end - 1])) { end--; }
    }
    if (end <= contentStart) { return undefined; }
    return { value: text.slice(contentStart, end), start: contentStart, end };
}

export function extractFileReferences(text: string): StataFileReference[] {
    const source = scanStata(text);
    const references: StataFileReference[] = [];
    for (const statement of source.statements) {
        const stripped = stripPrefixes(statement.text);
        const command = stripped.text.match(/^([a-z]+)\b/i)?.[1].toLowerCase();
        if (!command) { continue; }
        let argument = -1;
        let extension: string | undefined;
        let rest = false;
        let directory = false;
        if (['do', 'run', 'include', 'use', 'u', 'us', 'save', 'sa', 'cd', 'erase', 'type', 'confirm'].includes(command)) {
            argument = command.length;
            extension = ['do', 'run', 'include'].includes(command) ? '.do' : ['use', 'u', 'us', 'save', 'sa'].includes(command) ? '.dta' : undefined;
            rest = !['do', 'run', 'include', 'confirm'].includes(command);
            directory = command === 'cd';
            if (['use', 'u', 'us'].includes(command)) {
                const using = /\busing\b/i.exec(statement.code.slice(stripped.offset));
                if (using) { argument = using.index + using[0].length; }
            }
            if (command === 'confirm') {
                const file = stripped.text.match(/^confirm\s+file\s+/i);
                if (!file) { continue; }
                argument = file[0].length;
            }
        } else if (command === 'graph') {
            const graph = stripped.text.match(/^graph\s+(export|save|use)\s+/i);
            if (!graph) { continue; }
            argument = graph[0].length;
            extension = graph[1].toLowerCase() === 'export' ? undefined : '.gph';
            rest = true;
        } else if (['import', 'export', 'merge', 'append', 'joinby', 'cross', 'infile', 'infix', 'insheet', 'outsheet', 'log', 'cmdlog', 'esttab', 'estout', 'outreg2'].includes(command)) {
            const code = statement.code.slice(stripped.offset);
            const using = /\busing\b/i.exec(code);
            if (using) { argument = using.index + using[0].length; }
            else if (['import', 'export'].includes(command)) {
                const format = stripped.text.match(/^(?:import|export)\s+(?:delimited|excel|sas|spss|sasxport5|sasxport8|dbase)\s+/i);
                if (format) { argument = format[0].length; }
            }
            if (argument < 0) { continue; }
            extension = ['merge', 'append', 'joinby', 'cross'].includes(command) ? '.dta' : undefined;
            rest = true;
        }
        if (argument < 0) { continue; }
        const file = readPath(stripped.text, argument, rest);
        if (!file) { continue; }
        const base = statement.start + stripped.offset;
        references.push({ start: base + file.start, end: base + file.end, path: file.value, extension, directory });
    }
    return references;
}

function expandGlobals(value: string, globals: Map<string, string | undefined>): string | undefined {
    const expanded = value.replace(/\$\{([a-zA-Z_]\w*)\}|\$([a-zA-Z_]\w*)/g, (match, braced, name) => globals.get(braced ?? name) ?? match);
    return /[$`]/.test(expanded) ? undefined : expanded;
}

export function resolveStataPath(value: string, base: string): string | undefined {
    if (/^[a-z]+:\/\//i.test(value) || /^~|^[a-z]:[^\\/]/i.test(value)) { return undefined; }
    const flavor = pathFlavor(value) === path.win32 || pathFlavor(base) === path.win32 ? path.win32 : path.posix;
    if (flavor === path.posix) { value = value.replace(/\\/g, '/'); }
    // A root-relative Windows path needs a known drive; avoid using the host's cwd.
    if (flavor === path.win32 && /^[\\/](?![\\/])/.test(value) && pathFlavor(base) !== path.win32) { return undefined; }
    return flavor.resolve(base, value);
}

export function resolveFileLinks(text: string, documentPath: string, exists: (file: string) => boolean): ResolvedStataLink[] {
    const source = scanStata(text);
    const definitions = parseDefinitions(source);
    const programs = definitions.filter(d => d.kind === 'program');
    const globals = definitions.filter(d => d.kind === 'global' && d.scope === -1);
    const values = new Map<string, string | undefined>();
    let definitionIndex = 0;
    const documentDirectory = pathFlavor(documentPath).dirname(documentPath);
    let directory: string | undefined = documentDirectory;
    const programStates = new Map<number, { directory: string | undefined; values: Map<string, string | undefined>; index: number }>();
    const links: ResolvedStataLink[] = [];
    const safeExists = (file: string) => {
        try { return exists(file); } catch { return false; }
    };
    for (const reference of extractFileReferences(text)) {
        while (definitionIndex < globals.length && globals[definitionIndex].start < reference.start) {
            const definition = globals[definitionIndex++];
            values.set(definition.name, definition.value === undefined ? undefined : expandGlobals(definition.value, values));
        }
        const program = programs.find(p => reference.start >= p.start && reference.start <= p.end);
        let state = program ? programStates.get(program.start) : undefined;
        if (program && !state) {
            state = { directory, values: new Map(values), index: 0 };
            programStates.set(program.start, state);
        }
        if (state && program) {
            const scopedGlobals = definitions.filter(d => d.kind === 'global' && d.scope === program.start);
            while (state.index < scopedGlobals.length && scopedGlobals[state.index].start < reference.start) {
                const definition = scopedGlobals[state.index++];
                state.values.set(definition.name, definition.value === undefined ? undefined : expandGlobals(definition.value, state.values));
            }
        }
        const base: string | undefined = state ? state.directory : directory;
        const expanded = expandGlobals(reference.path, state?.values ?? values);
        const absolute = expanded !== undefined && pathFlavor(expanded).isAbsolute(expanded);
        const target: string | undefined = expanded === undefined || (!base && !absolute) ? undefined : resolveStataPath(expanded, base ?? documentDirectory);
        if (reference.directory) {
            const next: string | undefined = target && safeExists(target) ? target : undefined;
            if (state) { state.directory = next; }
            else { directory = next; }
        }
        if (!target) { continue; }
        const flavor = pathFlavor(target);
        const candidates = reference.extension && !flavor.extname(target) ? [target + reference.extension, target] : [target];
        const existing = candidates.find(safeExists);
        if (existing) { links.push({ ...reference, target: existing }); }
    }
    return links;
}
