import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface ResultItem {
    type: 'section' | 'scalar' | 'macro';
    name: string;
    value: string;
    section?: string;
}

type TreeNode = ResultSection | ResultEntry;

class ResultSection {
    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly icon: string,
        public readonly children: ResultEntry[],
    ) {}
}

class ResultEntry {
    constructor(
        public readonly name: string,
        public readonly value: string,
        public readonly section: string,
    ) {}
}

export class StoredResultsPanel implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sections: ResultSection[] = [];

    refreshFromFile(resultsPath: string): void {
        this.sections = [];

        if (!resultsPath || !fs.existsSync(resultsPath)) {
            this._onDidChangeTreeData.fire();
            return;
        }

        const content = fs.readFileSync(resultsPath, 'utf-8').trim();
        const lines = content.split('\n');
        if (lines.length <= 1) {
            this._onDidChangeTreeData.fire();
            return;
        }

        const scalars: ResultEntry[] = [];
        const macros: ResultEntry[] = [];

        for (const line of lines.slice(1)) {
            const parts = line.split('\t');
            const type = (parts[0] || '').trim();
            const name = (parts[1] || '').trim();
            const value = (parts[2] || '').trim();
            if (!name) { continue; }

            if (type === 'e') {
                scalars.push(new ResultEntry(name, value, 'scalars'));
            } else if (type === 'em') {
                macros.push(new ResultEntry(name, value, 'macros'));
            }
        }

        if (scalars.length > 0) {
            this.sections.push(new ResultSection('scalars', 'Scalars', 'symbol-number', scalars));
        }
        if (macros.length > 0) {
            this.sections.push(new ResultSection('macros', 'Macros', 'symbol-string', macros));
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element instanceof ResultSection) {
            const item = new vscode.TreeItem(
                `${element.label} (${element.children.length})`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.iconPath = new vscode.ThemeIcon(element.icon);
            item.contextValue = 'section';
            return item;
        }

        const entry = element;
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);

        // Format numeric values nicely
        const num = parseFloat(entry.value);
        if (!isNaN(num) && entry.value !== '') {
            if (Number.isInteger(num)) {
                item.description = num.toLocaleString();
            } else {
                item.description = num.toPrecision(6);
            }
        } else {
            item.description = entry.value || '(empty)';
        }

        item.tooltip = `${entry.name} = ${entry.value}`;
        item.iconPath = entry.section === 'scalars'
            ? new vscode.ThemeIcon('symbol-number')
            : new vscode.ThemeIcon('symbol-text');
        return item;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!element) {
            return this.sections;
        }
        if (element instanceof ResultSection) {
            return element.children;
        }
        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
