import * as vscode from 'vscode';
import { resolveCommand } from './stataCommands';
import { macroReferenceAt, parseDefinitions, scanStata, visibleMacros } from './stataSyntax';

export class StataHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const source = scanStata(text);
        if (source.contexts[offset] === 1) { return undefined; }
        const macro = macroReferenceAt(text, offset);
        if (macro) {
            const definition = visibleMacros(parseDefinitions(source), offset).find(d => d.name === macro.name && d.kind === macro.kind);
            if (!definition) { return undefined; }
            const md = new vscode.MarkdownString();
            md.appendText(`${macro.kind} ${macro.name}`);
            if (definition.value !== undefined) { md.appendCodeblock(definition.value, 'stata'); }
            return new vscode.Hover(md, new vscode.Range(document.positionAt(macro.start), document.positionAt(macro.end)));
        }
        if (source.contexts[offset]) { return undefined; }
        const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!range) { return undefined; }
        const command = resolveCommand(document.getText(range));
        if (!command) { return undefined; }
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${command.label}** — ${command.detail}`);
        return new vscode.Hover(md, range);
    }
}
