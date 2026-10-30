import * as vscode from 'vscode';
import { macroReferenceAt, parseDefinitions, scanStata, StataDefinition, visibleMacros } from './stataSyntax';

const EXCLUDE = '**/{node_modules,.git,out,dist,build}/**';
const MAX_FILES = 500;

export class StataDefinitionProvider implements vscode.DefinitionProvider {
    private readonly cache = new WeakMap<vscode.TextDocument, { version: number; definitions: StataDefinition[] }>();

    private definitions(document: vscode.TextDocument): StataDefinition[] {
        const cached = this.cache.get(document);
        if (cached?.version === document.version) { return cached.definitions; }
        const definitions = parseDefinitions(scanStata(document.getText()));
        this.cache.set(document, { version: document.version, definitions });
        return definitions;
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<vscode.Location | vscode.Location[] | undefined> {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const source = scanStata(text);
        if (source.contexts[offset] === 1) { return undefined; }
        const location = (doc: vscode.TextDocument, definition: StataDefinition) => new vscode.Location(
            doc.uri, new vscode.Range(doc.positionAt(definition.start), doc.positionAt(definition.start + definition.name.length)),
        );
        const definitions = this.definitions(document);
        const macro = macroReferenceAt(text, offset);
        if (macro) {
            const definition = visibleMacros(definitions, offset).find(d => d.name === macro.name && d.kind === macro.kind);
            return definition ? location(document, definition) : undefined;
        }
        if (source.contexts[offset]) { return undefined; }
        const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!range) { return undefined; }
        const word = document.getText(range);
        const local = definitions.find(d => (d.kind === 'program' || d.kind === 'label') && d.name === word);
        if (local) { return location(document, local); }
        if (token?.isCancellationRequested) { return undefined; }
        // The usual ado-file name is a cheap first pass; only scan the wider workspace if needed.
        const named = await vscode.workspace.findFiles(`**/${word}.{do,ado}`, EXCLUDE, 20, token);
        const search = async (uris: vscode.Uri[]): Promise<vscode.Location[]> => {
            const results: vscode.Location[] = [];
            for (let i = 0; i < uris.length && !token?.isCancellationRequested; i += 8) {
                const batch = await Promise.all(uris.slice(i, i + 8).map(async uri => {
                    if (uri.toString() === document.uri.toString()) { return []; }
                    try {
                        const candidate = await vscode.workspace.openTextDocument(uri);
                        if (token?.isCancellationRequested) { return []; }
                        return this.definitions(candidate).filter(d => d.kind === 'program' && d.name === word).map(d => location(candidate, d));
                    } catch { return []; }
                }));
                results.push(...batch.flat());
            }
            return results;
        };
        const exact = await search(named);
        if (token?.isCancellationRequested) { return undefined; }
        if (exact.length) { return exact; }
        const files = await vscode.workspace.findFiles('**/*.{do,ado}', EXCLUDE, MAX_FILES, token);
        const namedKeys = new Set(named.map(uri => uri.toString()));
        const results = await search(files.filter(uri => !namedKeys.has(uri.toString())));
        return token?.isCancellationRequested || !results.length ? undefined : results;
    }
}
