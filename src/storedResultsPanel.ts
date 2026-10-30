import * as vscode from 'vscode';
import * as fs from 'fs';
import { type StoredResultItem, parseResultsTsv } from './sidebarUtils';

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
    constructor(public readonly item: StoredResultItem) {}
}

const COPY_RESULT_CMD = 'stata._copyStoredResultValue';
let copyCommandRegistered = false;

function ensureCopyResultCommand(): void {
    if (copyCommandRegistered) {
        return;
    }
    copyCommandRegistered = true;
    try {
        vscode.commands.registerCommand(
            COPY_RESULT_CMD,
            async (payload?: { accessor?: unknown; value?: unknown }) => {
                if (!payload || typeof payload.value !== 'string') {
                    return;
                }
                await vscode.env.clipboard.writeText(payload.value);
                const label = typeof payload.accessor === 'string' ? payload.accessor : 'value';
                vscode.window.setStatusBarMessage(`Copied ${label} to clipboard`, 2500);
            },
        );
    } catch {
        // Command may already exist
    }
}

export class StoredResultsPanel implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sections: ResultSection[] = [];
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        ensureCopyResultCommand();
    }

    refreshFromFile(resultsPath: string): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.loadFromFile(resultsPath, true);
    }

    private loadFromFile(resultsPath: string, allowRetry: boolean): void {
        if (!resultsPath) {
            this.sections = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        let raw: string;
        try {
            if (!fs.existsSync(resultsPath)) {
                this.sections = [];
                this._onDidChangeTreeData.fire();
                return;
            }
            raw = fs.readFileSync(resultsPath, 'utf-8');
        } catch {
            // File may be mid-write or temporarily locked on Windows
            if (allowRetry) {
                this.scheduleRetry(resultsPath);
            }
            this._onDidChangeTreeData.fire();
            return;
        }

        const isUnterminated = raw.length > 0 && !raw.endsWith('\n') && !raw.endsWith('\r');
        const groups = parseResultsTsv(raw, { dropUnterminatedLastLine: isUnterminated });
        this.sections = groups.map(
            (g) => new ResultSection(g.id, g.label, g.icon, g.items.map((item) => new ResultEntry(item))),
        );
        this._onDidChangeTreeData.fire();

        if (isUnterminated && allowRetry) {
            this.scheduleRetry(resultsPath);
        }
    }

    private scheduleRetry(resultsPath: string): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.loadFromFile(resultsPath, false);
        }, 75);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element instanceof ResultSection) {
            const item = new vscode.TreeItem(
                `${element.label} (${element.children.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            item.iconPath = new vscode.ThemeIcon(element.icon);
            item.contextValue = 'section';
            return item;
        }

        const { item: entry } = element;
        const treeItem = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        treeItem.description = entry.formattedValue;
        treeItem.tooltip = `${entry.accessor} = ${entry.value || '(empty)'}\nClick to copy value`;
        treeItem.iconPath = entry.isScalar
            ? new vscode.ThemeIcon('symbol-number')
            : new vscode.ThemeIcon('symbol-text');
        treeItem.contextValue = entry.isScalar ? 'stataStoredScalar' : 'stataStoredMacro';
        treeItem.command = {
            command: COPY_RESULT_CMD,
            title: 'Copy Value',
            arguments: [{ accessor: entry.accessor, value: entry.value }],
        };
        return treeItem;
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
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this._onDidChangeTreeData.dispose();
    }
}
