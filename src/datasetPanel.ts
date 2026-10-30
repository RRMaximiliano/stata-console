import * as vscode from 'vscode';
import { crossPlatformBasename } from './htmlUtils';

interface DatasetInfo {
    key: string;
    value: string;
    icon: string;
    tooltip?: string;
    command?: vscode.Command;
}

export class DatasetPanel implements vscode.TreeDataProvider<DatasetInfo> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DatasetInfo | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: DatasetInfo[] = [];

    constructor() {
        this.items = this.createEmptyState();
    }

    private createEmptyState(): DatasetInfo[] {
        return [{
            key: 'No data in memory',
            value: '',
            icon: 'database',
            tooltip: 'Load a dataset in Stata (e.g. sysuse or use) to inspect dataset metadata here',
        }];
    }

    update(meta?: { obs: number; vars: number; filename: string; label: string }): void {
        const obs = meta && Number.isFinite(meta.obs) && meta.obs > 0 ? Math.floor(meta.obs) : 0;
        const vars = meta && Number.isFinite(meta.vars) && meta.vars > 0 ? Math.floor(meta.vars) : 0;

        if (!meta || (obs === 0 && vars === 0)) {
            this.items = this.createEmptyState();
            this._onDidChangeTreeData.fire();
            return;
        }

        const rawFilename = (meta.filename || '').trim();
        const name = rawFilename ? crossPlatformBasename(rawFilename) : '(unsaved)';

        this.items = [
            {
                key: 'Dataset',
                value: name,
                icon: 'database',
                tooltip: rawFilename ? `${rawFilename}\nClick to browse data` : 'Unsaved dataset in memory \u2014 click to browse data',
                command: { command: 'stata.browse', title: 'Browse Data' },
            },
            {
                key: 'Observations',
                value: obs.toLocaleString(),
                icon: 'list-ordered',
                tooltip: `${obs.toLocaleString()} observations`,
            },
            {
                key: 'Variables',
                value: vars.toLocaleString(),
                icon: 'symbol-field',
                tooltip: `${vars.toLocaleString()} variables`,
            },
        ];

        const cleanLabel = (meta.label || '').trim();
        if (cleanLabel) {
            this.items.push({
                key: 'Label',
                value: cleanLabel,
                icon: 'tag',
                tooltip: cleanLabel,
            });
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DatasetInfo): vscode.TreeItem {
        const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.tooltip) {
            item.tooltip = element.tooltip;
        }
        if (element.command) {
            item.command = element.command;
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
