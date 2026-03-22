import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Patterns that reference files in Stata code
const FILE_PATTERNS = [
    // do "file.do", run "file.do"
    /\b(do|run)\s+"([^"]+)"/gi,
    // use "file.dta", save "file.dta"
    /\b(use|save|u|us)\s+"([^"]+)"/gi,
    // import/export delimited ... using "file"
    /\busing\s+"([^"]+)"/gi,
    // log using "file"
    /\blog\s+using\s+"([^"]+)"/gi,
    // graph export "file"
    /\bgraph\s+export\s+"([^"]+)"/gi,
    // include "file"
    /\binclude\s+"([^"]+)"/gi,
    // cd "path"
    /\bcd\s+"([^"]+)"/gi,
];

export class StataLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
    ): vscode.DocumentLink[] {
        const links: vscode.DocumentLink[] = [];
        const docDir = path.dirname(document.uri.fsPath);

        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const lineText = document.lineAt(lineNum).text;

            for (const pattern of FILE_PATTERNS) {
                // Reset regex lastIndex for each line
                pattern.lastIndex = 0;
                let match: RegExpExecArray | null;

                while ((match = pattern.exec(lineText)) !== null) {
                    // The file path is in the last capture group
                    const filePath = match[match.length - 1];
                    if (!filePath) { continue; }

                    // Find the position of the quoted path in the line
                    const quoteStart = lineText.indexOf(`"${filePath}"`, match.index);
                    if (quoteStart < 0) { continue; }

                    // Range covers just the path inside quotes
                    const start = new vscode.Position(lineNum, quoteStart + 1);
                    const end = new vscode.Position(lineNum, quoteStart + 1 + filePath.length);
                    const range = new vscode.Range(start, end);

                    // Resolve relative paths against the document's directory
                    const resolved = path.isAbsolute(filePath)
                        ? filePath
                        : path.resolve(docDir, filePath);

                    if (fs.existsSync(resolved)) {
                        const link = new vscode.DocumentLink(
                            range,
                            vscode.Uri.file(resolved)
                        );
                        link.tooltip = resolved;
                        links.push(link);
                    }
                }
            }
        }

        return links;
    }
}
