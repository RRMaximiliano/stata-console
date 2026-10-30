import * as vscode from 'vscode';
import { buildOutline, StataOutlineSymbol } from './stataOutline';

export class StataOutlineProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const convert = (symbol: StataOutlineSymbol): vscode.DocumentSymbol => {
            const kind = symbol.kind === 'section' ? vscode.SymbolKind.Module : symbol.kind === 'program' ? vscode.SymbolKind.Function : symbol.kind === 'loop' ? vscode.SymbolKind.Variable : vscode.SymbolKind.Event;
            const result = new vscode.DocumentSymbol(
                symbol.name, symbol.kind, kind,
                new vscode.Range(document.positionAt(symbol.start), document.positionAt(symbol.end)),
                new vscode.Range(document.positionAt(symbol.selectionStart), document.positionAt(symbol.selectionEnd)),
            );
            result.children = symbol.children.map(convert);
            return result;
        };
        return buildOutline(document.getText()).map(convert);
    }
}
