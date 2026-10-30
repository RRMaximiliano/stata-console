export interface StataStatement {
    start: number;
    end: number;
    text: string;
    code: string;
}

export interface StataSource {
    text: string;
    clean: string;
    code: string;
    contexts: Uint8Array;
    starComments: number[];
    statements: StataStatement[];
}

// Offsets are preserved in both views: clean removes comments; code also removes strings.
export function scanStata(text: string): StataSource {
    const clean = text.split('');
    const code = text.split('');
    const contexts = new Uint8Array(text.length + 1);
    const starComments: number[] = [];
    const continuations = new Set<number>();
    const strings: string[] = [];
    let blockDepth = 0;
    let lineComment: 'slash' | 'star' | undefined;
    let statementStart = true;
    let continued = false;
    let semicolon = false;
    let mata = false;
    let lineStart = 0;
    for (let i = 0; i < text.length; i++) {
        const pair = text.slice(i, i + 2);
        const ch = text[i];
        if (ch === '\n') {
            contexts[i] = lineComment || blockDepth ? 1 : strings.length ? 2 : 0;
            if (blockDepth || continued || strings[strings.length - 1] === 'compound') { continuations.add(i); }
            if (!blockDepth && !strings.length) {
                const line = code.slice(lineStart, i).join('').trim();
                if (/^mata\s*:?\s*$/.test(line)) { mata = true; }
                else if (/^end\s*$/.test(line)) { mata = false; }
                const directive = !mata && line.match(/^#delimit\s+(;|cr)\s*$/i);
                if (directive) { semicolon = directive[1] === ';'; statementStart = true; }
            }
            lineStart = i + 1;
            if (lineComment !== 'star' || !semicolon) { lineComment = undefined; }
            if (strings[strings.length - 1] === 'simple') { strings.pop(); }
            if (!semicolon && !continuations.has(i)) { statementStart = true; }
            continued = false;
            continue;
        }
        if (lineComment || blockDepth) {
            if (lineComment === 'star' && semicolon && ch === ';') {
                lineComment = undefined;
                statementStart = true;
                continue;
            }
            contexts[i] = 1;
            if (!lineComment && pair === '/*') { blockDepth++; }
            if (!lineComment && pair === '*/') {
                blockDepth--;
                clean[i] = code[i] = ' ';
                i++;
                contexts[i] = 1;
            }
            clean[i] = code[i] = ' ';
            continue;
        }
        if (strings.length) {
            contexts[i] = 2;
            code[i] = ' ';
            if (strings[strings.length - 1] === 'compound' && pair === '`"') {
                strings.push('compound');
                code[++i] = ' ';
                contexts[i] = 2;
            } else if (strings[strings.length - 1] === 'compound' && pair === '"\'') {
                strings.pop();
                code[++i] = ' ';
                contexts[i] = 2;
            } else if (strings[strings.length - 1] === 'simple' && ch === '"') {
                strings.pop();
            }
            continue;
        }
        if (pair === '/*') {
            blockDepth = 1;
            contexts[i] = contexts[i + 1] = 1;
            clean[i] = code[i] = clean[i + 1] = code[i + 1] = ' ';
            i++;
        } else if ((pair === '//' && (statementStart || /\s/.test(text[i - 1]))) || (ch === '*' && statementStart && !mata)) {
            if (ch === '*') { starComments.push(i); }
            lineComment = ch === '*' ? 'star' : 'slash';
            continued = text.slice(i, i + 3) === '///';
            clean[i] = code[i] = ' ';
            contexts[i] = 1;
        } else if (pair === '`"' || ch === '"') {
            strings.push(pair === '`"' ? 'compound' : 'simple');
            statementStart = false;
            code[i] = ' ';
            contexts[i] = 2;
            if (pair === '`"') { code[++i] = ' '; contexts[i] = 2; }
        } else if (semicolon && ch === ';') {
            statementStart = true;
        } else if (!/\s/.test(ch)) {
            statementStart = false;
        }
    }
    contexts[text.length] = lineComment || blockDepth ? 1 : strings.length ? 2 : 0;
    const result: StataSource = { text, clean: clean.join(''), code: code.join(''), contexts, starComments, statements: [] };
    let start = 0;
    semicolon = false;
    for (let i = 0; i <= text.length; i++) {
        const newline = text[i] === '\n';
        const directive = newline && result.code.slice(start, i).trim().match(/^#delimit\s+(;|cr)$/i);
        if (i === text.length || directive || (semicolon ? result.code[i] === ';' : newline && !continuations.has(i))) {
            if (result.clean.slice(start, i).trim()) {
                result.statements.push({ start, end: i, text: result.clean.slice(start, i), code: result.code.slice(start, i) });
            }
            start = i + 1;
            if (directive) { semicolon = directive[1] === ';'; }
        }
    }
    return result;
}

export function stripPrefixes(text: string): { text: string; offset: number } {
    let offset = 0;
    let match: RegExpMatchArray | null;
    while ((match = text.slice(offset).match(/^\s*(?:(?:qui(?:etly)?|cap(?:ture)?|noi(?:sily)?)\s*:?\s+|(?:by|bys(?:ort)?)\s+[^:]+:\s*)/i))) {
        offset += match[0].length;
    }
    const spaces = text.slice(offset).match(/^\s*/)?.[0].length ?? 0;
    offset += spaces;
    return { text: text.slice(offset), offset };
}

export interface StataDefinition {
    name: string;
    kind: 'program' | 'local' | 'global' | 'label';
    start: number;
    end: number;
    scope: number;
    value?: string;
}

export function parseDefinitions(source: StataSource): StataDefinition[] {
    const definitions: StataDefinition[] = [];
    let program: StataDefinition | undefined;
    let mata = false;
    for (const statement of source.statements) {
        const stripped = stripPrefixes(statement.code);
        const text = stripped.text;
        const start = statement.start + stripped.offset;
        if (/^mata\s*:?\s*$/i.test(text)) { mata = true; continue; }
        if (/^end\s*$/i.test(text)) {
            if (mata) { mata = false; }
            else if (program) { program.end = statement.end; program = undefined; }
            continue;
        }
        if (mata) { continue; }
        const prog = text.match(/^(?:pr(?:ogram)?)\s+(?:(?:de(?:fine)?)\s+)?([a-zA-Z_]\w*)\b/);
        if (prog && (/^(?:pr(?:ogram)?)\s+de(?:fine)?\s+/.test(text) || !/^(?:drop|dir|list|define|de)$/i.test(prog[1]))) {
            const nameStart = start + prog[0].lastIndexOf(prog[1]);
            program = { name: prog[1], kind: 'program', start: nameStart, end: source.text.length, scope: -1 };
            definitions.push(program);
            continue;
        }
        const macro = text.match(/^(local|global|loc|glo)\s+([a-zA-Z_]\w*)\b/);
        if (macro) {
            const nameStart = start + macro[0].lastIndexOf(macro[2]);
            const raw = source.clean.slice(start + macro[0].length, statement.end).trim();
            definitions.push({
                name: macro[2], kind: macro[1].startsWith('loc') ? 'local' : 'global',
                start: nameStart, end: nameStart + macro[2].length, scope: program?.start ?? -1,
                value: /^[=:]/.test(raw) ? undefined : unquote(raw),
            });
            continue;
        }
        const loop = text.match(/^(?:foreach|forvalues)\s+([a-zA-Z_]\w*)\b/);
        if (loop) {
            const nameStart = start + loop[0].lastIndexOf(loop[1]);
            definitions.push({ name: loop[1], kind: 'local', start: nameStart, end: nameStart + loop[1].length, scope: program?.start ?? -1 });
        }
        const label = text.match(/^label\s+(?:de(?:fine)?)\s+([a-zA-Z_]\w*)\b/);
        if (label) {
            const nameStart = start + label[0].lastIndexOf(label[1]);
            definitions.push({ name: label[1], kind: 'label', start: nameStart, end: nameStart + label[1].length, scope: -1 });
        }
    }
    return definitions;
}

export function unquote(value: string): string {
    if (value.startsWith('`"') && value.endsWith('"\'')) { return value.slice(2, -2); }
    if (value.startsWith('"') && value.endsWith('"')) { return value.slice(1, -1); }
    return value;
}

export function visibleMacros(definitions: StataDefinition[], offset: number): StataDefinition[] {
    const scope = definitions.find(d => d.kind === 'program' && offset >= d.start && offset <= d.end)?.start ?? -1;
    const found = new Map<string, StataDefinition>();
    for (const definition of definitions) {
        if (definition.start >= offset || !['local', 'global'].includes(definition.kind)) { continue; }
        if (definition.kind === 'local' ? definition.scope !== scope : definition.scope !== -1 && definition.scope !== scope) { continue; }
        found.set(`${definition.kind}:${definition.name}`, definition);
    }
    return [...found.values()];
}

export function macroReferenceAt(text: string, offset: number): { name: string; kind: 'local' | 'global'; start: number; end: number } | undefined {
    const pattern = /\$\{([a-zA-Z_]\w*)\}|\$([a-zA-Z_]\w*)|`([a-zA-Z_]\w*)'/g;
    for (const match of text.matchAll(pattern)) {
        const start = match.index!;
        if (offset >= start && offset <= start + match[0].length) {
            return { name: match[1] ?? match[2] ?? match[3], kind: match[3] ? 'local' : 'global', start, end: start + match[0].length };
        }
    }
    return undefined;
}
