import { parseDefinitions, scanStata, stripPrefixes } from './stataSyntax';

export interface StataSection {
    title: string;
    level: number;
}

export interface StataOutlineSymbol {
    name: string;
    kind: 'section' | 'program' | 'loop' | 'drop';
    start: number;
    end: number;
    selectionStart: number;
    selectionEnd: number;
    children: StataOutlineSymbol[];
}

export function detectSection(line: string, neighborSeparator = false): StataSection | undefined {
    const bookmark = line.match(/^\s*\*\*(#+)\s*(.+?)\s*$/);
    if (bookmark && /[\p{L}\p{N}]/u.test(bookmark[2])) { return { title: bookmark[2], level: bookmark[1].length }; }
    if (!/^\s*\*/.test(line)) { return undefined; }
    const body = line.replace(/^\s*\*+\s*/, '').trim();
    if (!/[\p{L}\p{N}]/u.test(body)) { return undefined; }
    const title = body.replace(/^[-=*_~|+#\s]+|[-=*_~|+#\s]+$/g, '').trim();
    const numbered = title.match(/^(\d+(?:\.\d+)*)(?:[.)]|\.)\s+/);
    const decorated = /^[-=*_~]{2,}\s*\S/.test(body);
    const capitals = /\p{Lu}/u.test(title) && title === title.toUpperCase();
    if (!numbered && !decorated && !capitals && !neighborSeparator) { return undefined; }
    return { title, level: numbered ? numbered[1].split('.').length : 1 };
}

export function buildOutline(text: string): StataOutlineSymbol[] {
    const source = scanStata(text);
    const flat: StataOutlineSymbol[] = [];
    const sections: { symbol: StataOutlineSymbol; level: number }[] = [];
    const lines = text.split('\n');
    const starComments = new Set(source.starComments);
    const separator = (line: string) => /^\s*\*[-=*|_~#+\s]{3,}$/.test(line);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        const start = offset + (lines[i].match(/^\s*/)?.[0].length ?? 0);
        if (starComments.has(start)) {
            const section = detectSection(lines[i], separator(lines[i - 1] ?? '') || separator(lines[i + 1] ?? ''));
            if (section) {
                const symbol: StataOutlineSymbol = {
                    name: section.title, kind: 'section', start, end: text.length,
                    selectionStart: start, selectionEnd: offset + lines[i].trimEnd().length, children: [],
                };
                for (const previous of sections) {
                    if (previous.level >= section.level && previous.symbol.end === text.length) { previous.symbol.end = Math.max(previous.symbol.selectionEnd, start - 1); }
                }
                sections.push({ symbol, level: section.level });
                flat.push(symbol);
            }
        }
        offset += lines[i].length + 1;
    }
    const programs = parseDefinitions(source).filter(d => d.kind === 'program');
    for (const section of sections) {
        const program = programs.find(p => section.symbol.start >= p.start && section.symbol.start <= p.end);
        if (program) { section.symbol.end = Math.min(section.symbol.end, program.end); }
    }
    for (const definition of programs) {
        const start = source.statements.find(s => definition.start >= s.start && definition.start <= s.end)?.start ?? definition.start;
        flat.push({ name: definition.name, kind: 'program', start, end: definition.end, selectionStart: definition.start, selectionEnd: definition.start + definition.name.length, children: [] });
    }
    const braceCode = source.code.replace(/\$\{[^}]*\}|`[^'\n]*'/g, match => ' '.repeat(match.length));
    for (const statement of source.statements) {
        const stripped = stripPrefixes(statement.code);
        const start = statement.start + stripped.offset;
        const drop = stripped.text.match(/^(?:pr(?:ogram)?)\s+drop\s+([a-zA-Z_]\w*|_all)\b/);
        if (drop) {
            const selectionStart = start + drop[0].lastIndexOf(drop[1]);
            flat.push({ name: `drop ${drop[1]}`, kind: 'drop', start, end: statement.end, selectionStart, selectionEnd: selectionStart + drop[1].length, children: [] });
        }
        const loop = braceCode.slice(start, statement.end).match(/^(foreach|forvalues|while)\s+[^\n]*?\{/);
        if (!loop) { continue; }
        const brace = start + loop[0].length - 1;
        let depth = 1;
        let end = brace + 1;
        while (end < text.length && depth) {
            if (braceCode[end] === '{') { depth++; }
            if (braceCode[end] === '}') { depth--; }
            end++;
        }
        flat.push({ name: source.clean.slice(start, brace).trim(), kind: 'loop', start, end, selectionStart: start, selectionEnd: brace, children: [] });
    }
    flat.sort((a, b) => a.start - b.start || b.end - a.end);
    const roots: StataOutlineSymbol[] = [];
    const stack: StataOutlineSymbol[] = [];
    for (const symbol of flat) {
        while (stack.length && (symbol.start >= stack[stack.length - 1].end || symbol.end > stack[stack.length - 1].end)) { stack.pop(); }
        (stack.length ? stack[stack.length - 1].children : roots).push(symbol);
        if (symbol.kind !== 'drop') { stack.push(symbol); }
    }
    return roots;
}
