import * as vscode from 'vscode';
import * as fs from 'fs';

export interface StataVariable {
    name: string;
    type: string;
    format: string;
    label: string;
}

export class VariablesPanel implements vscode.TreeDataProvider<StataVariable> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StataVariable | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private variables: StataVariable[] = [];

    refreshFromFile(varsPath: string): void {
        if (!varsPath || !fs.existsSync(varsPath)) {
            this.variables = [];
            this._onDidChangeTreeData.fire();
            return;
        }
        const content = fs.readFileSync(varsPath, 'utf-8').trim();
        const lines = content.split('\n');
        if (lines.length <= 1) {
            this.variables = [];
        } else {
            this.variables = lines.slice(1).map(line => {
                const parts = line.split('\t');
                return {
                    name: (parts[0] || '').trim(),
                    type: (parts[1] || '').trim(),
                    format: (parts[2] || '').trim(),
                    label: (parts[3] || '').trim(),
                };
            }).filter(v => v.name !== '');
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(v: StataVariable): vscode.TreeItem {
        const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
        item.description = v.label || v.type;
        item.tooltip = new vscode.MarkdownString(
            `**${v.name}** \`${v.type}\` \`${v.format}\`${v.label ? '\n\n' + v.label : ''}`
        );
        item.iconPath = this.getTypeIcon(v.type);
        item.command = {
            command: 'stata.insertVariable',
            title: 'Insert Variable',
            arguments: [v.name],
        };
        return item;
    }

    getChildren(): StataVariable[] {
        return this.variables;
    }

    private getTypeIcon(type: string): vscode.ThemeIcon {
        if (/^str/.test(type)) {
            return new vscode.ThemeIcon('symbol-string');
        }
        if (/^(byte|int|long|float|double)$/.test(type)) {
            return new vscode.ThemeIcon('symbol-number');
        }
        return new vscode.ThemeIcon('symbol-variable');
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
