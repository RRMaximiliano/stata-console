import { COMMANDS } from './stataCommands';
import { parseDefinitions, scanStata, StataSource, stripPrefixes, visibleMacros } from './stataSyntax';

export interface StataCompletion {
    label: string;
    insertText: string;
    start: number;
    end: number;
    detail: string;
    kind: 'local' | 'global' | 'variable';
}

export function macroCompletions(source: StataSource, offset: number): StataCompletion[] | undefined {
    if (source.contexts[offset] === 1) { return []; }
    const before = source.text.slice(0, offset);
    const match = before.match(/(`|\$\{?)([a-zA-Z_]\w*|)$/);
    if (!match) { return undefined; }
    const kind = match[1] === '`' ? 'local' : 'global';
    const start = offset - match[0].length;
    const suffix = source.text.slice(offset).match(/^\w*/)?.[0] ?? '';
    const closing = kind === 'local' ? '\'' : match[1] === '${' ? '}' : '';
    const end = offset + suffix.length + (closing && source.text[offset + suffix.length] === closing ? 1 : 0);
    return visibleMacros(parseDefinitions(source), offset)
        .filter(d => d.kind === kind && d.name.startsWith(match[2]))
        .map(d => ({ label: `${match[1]}${d.name}${closing}`, insertText: `${match[1]}${d.name}${closing}`, start, end, detail: `${kind} macro${d.value === undefined ? '' : `: ${d.value}`}`, kind }));
}

export function commandCompletionRange(source: StataSource, offset: number): { start: number; end: number } | undefined {
    if (source.contexts[offset]) { return undefined; }
    const statement = source.statements.find(s => offset >= s.start && offset <= s.end);
    const start = statement?.start ?? source.text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = stripPrefixes(source.code.slice(start, offset));
    if (!/^[a-zA-Z_\s]*$/.test(prefix.text)) { return undefined; }
    if (prefix.text.trim().includes(' ') && !COMMANDS.some(command => command.label.startsWith(prefix.text))) { return undefined; }
    // Once a command is followed by whitespace, offer its subcommands, not every command.
    if (/\s$/.test(prefix.text) && prefix.text.trim() && !COMMANDS.some(command => command.label.startsWith(prefix.text))) { return undefined; }
    const suffix = source.text.slice(offset).match(/^\w*/)?.[0].length ?? 0;
    return { start: start + prefix.offset, end: offset + suffix };
}

export function declaredVariables(text: string, offset = text.length): string[] {
    const source = scanStata(text);
    const names = new Set<string>();
    for (const statement of source.statements) {
        if (statement.start >= offset) { break; }
        const code = stripPrefixes(statement.code).text;
        const created = code.match(/^(?:gen(?:erate)?|egen)\s+(?:(?:byte|int|long|float|double|str\d+|strL)\s+)?([a-zA-Z_]\w*)\s*=/);
        const renamed = code.match(/^rename\s+([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*$/);
        if (created) { names.add(created[1]); }
        if (renamed) { names.delete(renamed[1]); names.add(renamed[2]); }
    }
    return [...names];
}
