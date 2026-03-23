import * as vscode from 'vscode';

export class StataDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Location | undefined {
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) { return undefined; }

        const word = document.getText(wordRange);

        // Search the current document for:
        //   program define {word}
        //   program {word}
        //   label define {word}
        const patterns = [
            new RegExp(`^\\s*program\\s+define\\s+${escapeRegex(word)}\\b`, 'i'),
            new RegExp(`^\\s*program\\s+${escapeRegex(word)}\\b`, 'i'),
            new RegExp(`^\\s*label\\s+define\\s+${escapeRegex(word)}\\b`, 'i'),
        ];

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            for (const pattern of patterns) {
                if (pattern.test(lineText)) {
                    // Find the position of the word in the matched line
                    const wordIndex = lineText.toLowerCase().indexOf(word.toLowerCase());
                    if (wordIndex >= 0) {
                        const pos = new vscode.Position(i, wordIndex);
                        return new vscode.Location(document.uri, pos);
                    }
                }
            }
        }

        return undefined;
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
