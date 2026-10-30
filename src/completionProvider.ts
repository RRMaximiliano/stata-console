import * as vscode from 'vscode';
import { COMMANDS, COMMAND_ALIASES } from './stataCommands';
import { commandCompletionRange, declaredVariables, macroCompletions } from './stataCompletions';
import { scanStata } from './stataSyntax';

export type StataVariableSource = (document: vscode.TextDocument) => readonly string[];

export class StataCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly variableSource?: StataVariableSource) {}

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const text = document.getText();
        const source = scanStata(text);
        const offset = document.offsetAt(position);
        const macros = macroCompletions(source, offset);
        if (macros) {
            return macros.map(macro => {
                const item = new vscode.CompletionItem(macro.label, vscode.CompletionItemKind.Variable);
                item.insertText = macro.insertText;
                item.detail = macro.detail;
                item.range = new vscode.Range(document.positionAt(macro.start), document.positionAt(macro.end));
                return item;
            });
        }
        if (source.contexts[offset]) { return []; }
        const commandRange = commandCompletionRange(source, offset);
        if (commandRange) {
            const range = new vscode.Range(document.positionAt(commandRange.start), document.positionAt(commandRange.end));
            const prefix = text.slice(commandRange.start, offset);
            return [
                ...COMMANDS.filter(command => command.label.startsWith(prefix)).map(command => {
                    const item = new vscode.CompletionItem(command.label, command.kind === 'keyword' ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Function);
                    item.detail = command.detail;
                    item.range = range;
                    return item;
                }),
                ...COMMAND_ALIASES.filter(alias => alias.label.startsWith(prefix)).map(alias => {
                    const item = new vscode.CompletionItem(alias.label, vscode.CompletionItemKind.Function);
                    item.detail = `${alias.command}: ${alias.detail}`;
                    item.range = range;
                    return item;
                }),
            ];
        }
        const word = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        const variables = new Set([...declaredVariables(text, offset), ...(this.variableSource?.(document) ?? [])]);
        return [...variables].filter(name => /^[a-zA-Z_]\w*$/.test(name)).map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
            item.detail = 'Stata variable';
            item.range = word;
            return item;
        });
    }
}
