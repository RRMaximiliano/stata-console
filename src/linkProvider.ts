import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveFileLinks } from './stataFileLinks';

export class StataLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        if (document.uri.scheme !== 'file') { return []; }
        return resolveFileLinks(document.getText(), document.uri.fsPath, fs.existsSync).map(reference => {
            const range = new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end));
            const link = new vscode.DocumentLink(range, vscode.Uri.file(reference.target));
            link.tooltip = reference.target;
            return link;
        });
    }
}
