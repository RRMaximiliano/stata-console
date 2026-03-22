import * as vscode from 'vscode';

interface DatasetInfo {
    key: string;
    value: string;
    icon: string;
    command?: vscode.Command;
}

export class DatasetPanel implements vscode.TreeDataProvider<DatasetInfo> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DatasetInfo | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: DatasetInfo[] = [];

    update(meta?: { obs: number; vars: number; filename: string; label: string }): void {
        if (!meta || (meta.obs === 0 && meta.vars === 0)) {
            this.items = [{
                key: 'No data in memory',
                value: '',
                icon: 'info',
            }];
            this._onDidChangeTreeData.fire();
            return;
        }

        const name = meta.filename
            ? meta.filename.replace(/^.*[/\\]/, '')
            : '(unsaved)';

        this.items = [
            {
                key: 'Dataset',
                value: name,
                icon: 'database',
                command: { command: 'stata.browse', title: 'Browse Data' },
            },
            {
                key: 'Observations',
                value: meta.obs.toLocaleString(),
                icon: 'list-ordered',
            },
            {
                key: 'Variables',
                value: meta.vars.toString(),
                icon: 'symbol-field',
            },
        ];

        if (meta.label) {
            this.items.push({
                key: 'Label',
                value: meta.label,
                icon: 'tag',
            });
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DatasetInfo): vscode.TreeItem {
        const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.command) {
            item.command = element.command;
            item.tooltip = 'Click to browse data';
        }
        return item;
    }

    getChildren(): DatasetInfo[] {
        return this.items;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
