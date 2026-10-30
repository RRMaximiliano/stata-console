import * as vscode from 'vscode';
import * as fs from 'fs';
import { PlotHistoryStore, sharedPlotHistoryStore } from './plotHistoryStore';

export interface PlotEntry {
    index: number;
    id: number;
    path: string;
    label: string;
    timestamp: Date;
    isActive: boolean;
}

export class PlotsListPanel implements vscode.TreeDataProvider<PlotEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PlotEntry | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly store: PlotHistoryStore;
    private readonly unsubscribeStore: () => void;

    constructor(store: PlotHistoryStore = sharedPlotHistoryStore) {
        this.store = store;
        this.unsubscribeStore = this.store.onChange(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    addPlot(plotPath: string): void {
        this.store.ingestFromPlotsList(plotPath);
    }

    deletePlot(index: number): void {
        this.store.deleteAt(index);
    }

    getTreeItem(element: PlotEntry): vscode.TreeItem {
        const exists = fs.existsSync(element.path);
        const item = new vscode.TreeItem(
            element.label,
            vscode.TreeItemCollapsibleState.None,
        );
        const timeStr = element.timestamp.toLocaleTimeString();
        item.description = element.isActive ? `${timeStr} \u2022 active` : timeStr;
        item.iconPath = new vscode.ThemeIcon(
            !exists ? 'warning' : element.isActive ? 'eye' : 'graph',
        );
        item.tooltip = exists
            ? `Click to view ${element.label} (${timeStr})`
            : 'Plot file not found';
        item.contextValue = 'stataPlotItem';

        if (exists) {
            item.command = {
                command: 'stata.showPlot',
                title: 'Show Plot',
                arguments: [element.index],
            };
        }
        return item;
    }

    getChildren(): PlotEntry[] {
        const plots = this.store.getPlots();
        const activeIdx = this.store.getCurrentIndex();
        const entries: PlotEntry[] = plots.map((record, idx) => ({
            index: idx,
            id: record.id,
            path: record.historyPath,
            label: `Plot ${idx + 1}`,
            timestamp: record.timestamp,
            isActive: idx === activeIdx,
        }));
        return entries.reverse();
    }

    clear(): void {
        this.store.clear();
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.unsubscribeStore();
        this._onDidChangeTreeData.dispose();
    }
}
