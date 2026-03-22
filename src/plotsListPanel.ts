import * as vscode from 'vscode';
import * as fs from 'fs';

interface PlotEntry {
    index: number;
    path: string;
    label: string;
    timestamp: Date;
}

export class PlotsListPanel implements vscode.TreeDataProvider<PlotEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PlotEntry | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private plots: PlotEntry[] = [];

    addPlot(plotPath: string): void {
        const index = this.plots.length + 1;
        this.plots.push({
            index,
            path: plotPath,
            label: `Plot ${index}`,
            timestamp: new Date(),
        });
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PlotEntry): vscode.TreeItem {
        const exists = fs.existsSync(element.path);
        const item = new vscode.TreeItem(
            element.label,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = element.timestamp.toLocaleTimeString();
        item.iconPath = new vscode.ThemeIcon(exists ? 'graph' : 'warning');
        item.tooltip = exists ? `Click to view — ${element.path}` : 'Plot file not found';

        if (exists) {
            item.command = {
                command: 'stata.showPlot',
                title: 'Show Plot',
                arguments: [element.index - 1],
            };
        }
        return item;
    }

    getChildren(): PlotEntry[] {
        return [...this.plots].reverse(); // newest first
    }

    clear(): void {
        this.plots = [];
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
