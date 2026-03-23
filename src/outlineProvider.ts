import * as vscode from 'vscode';

export class StataOutlineProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(
        document: vscode.TextDocument,
    ): vscode.DocumentSymbol[] {
        const symbols: vscode.DocumentSymbol[] = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;
            const trimmed = text.trim();

            // program define name  or  program name  (but not "program drop" or "program dir" etc.)
            const progMatch = trimmed.match(
                /^program\s+(?:define\s+)?(\w+)/i
            );
            if (progMatch) {
                const name = progMatch[1];
                // Skip Stata sub-commands that are not program definitions
                if (/^(drop|dir|list|define)$/i.test(name)) {
                    // "program define" already captured the real name;
                    // "program drop/dir/list" are not definitions
                    if (!/^program\s+define\s+/i.test(trimmed)) {
                        continue;
                    }
                }
                const range = line.range;
                const symbol = new vscode.DocumentSymbol(
                    name,
                    'program',
                    vscode.SymbolKind.Function,
                    range,
                    range,
                );
                symbols.push(symbol);
                continue;
            }

            // Section headers: lines starting with * --- or * === or * ***
            const sectionMatch = trimmed.match(
                /^\*\s*([-=*]{3,})\s*(.*)/
            );
            if (sectionMatch) {
                const afterMarker = sectionMatch[2].trim();
                // Use text after marker; if empty, use the whole line
                const sectionName = afterMarker
                    ? afterMarker.replace(/[-=*]+\s*$/, '').trim() || trimmed
                    : trimmed;
                const range = line.range;
                const symbol = new vscode.DocumentSymbol(
                    sectionName,
                    'section',
                    vscode.SymbolKind.Module,
                    range,
                    range,
                );
                symbols.push(symbol);
                continue;
            }

            // foreach ... { and forvalues ... {
            const loopMatch = trimmed.match(
                /^(foreach|forvalues)\s+(.+?)\s*\{/i
            );
            if (loopMatch) {
                const keyword = loopMatch[1];
                const rest = loopMatch[2].trim();
                const range = line.range;
                const symbol = new vscode.DocumentSymbol(
                    `${keyword} ${rest}`,
                    'loop',
                    vscode.SymbolKind.Variable,
                    range,
                    range,
                );
                symbols.push(symbol);
                continue;
            }
        }

        return symbols;
    }
}
