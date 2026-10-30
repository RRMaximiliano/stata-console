import * as vscode from 'vscode';
import * as fs from 'fs';
import { escapeMarkdown } from './htmlUtils';
import {
    type StataVariableInfo,
    type VariableSortMode,
    classifyVariableKind,
    filterAndSortVariables,
    parseVarsTsv,
} from './sidebarUtils';

export type StataVariable = StataVariableInfo;

class VariablesControlNode {
    readonly kind = 'control' as const;
}

type VariablesTreeNode = StataVariable | VariablesControlNode;

const FILTER_SORT_CMD = 'stata._variablesFilterSort';
let activeVariablesPanel: VariablesPanel | undefined;
let commandRegistered = false;

function ensureFilterSortCommand(): void {
    if (commandRegistered) {
        return;
    }
    commandRegistered = true;
    try {
        vscode.commands.registerCommand(FILTER_SORT_CMD, async () => {
            await activeVariablesPanel?.promptFilterOrSort();
        });
    } catch {
        // Command may already exist in rare reload scenarios
    }
}

function isControlNode(node: VariablesTreeNode): node is VariablesControlNode {
    return (node as VariablesControlNode).kind === 'control';
}

export class VariablesPanel implements vscode.TreeDataProvider<VariablesTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<VariablesTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private variables: StataVariable[] = [];
    private filterQuery = '';
    private sortMode: VariableSortMode = 'order';
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly controlNode = new VariablesControlNode();

    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        activeVariablesPanel = this;
        ensureFilterSortCommand();
    }

    refreshFromFile(varsPath: string): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.loadFromFile(varsPath, true);
    }

    private loadFromFile(varsPath: string, allowRetry: boolean): void {
        if (!varsPath) {
            this.variables = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        let raw: string;
        try {
            if (!fs.existsSync(varsPath)) {
                this.variables = [];
                this._onDidChangeTreeData.fire();
                return;
            }
            raw = fs.readFileSync(varsPath, 'utf-8');
        } catch {
            // File may be mid-write or temporarily locked on Windows
            if (allowRetry) {
                this.scheduleRetry(varsPath);
            }
            this._onDidChangeTreeData.fire();
            return;
        }

        const isUnterminated = raw.length > 0 && !raw.endsWith('\n') && !raw.endsWith('\r');
        this.variables = parseVarsTsv(raw, { dropUnterminatedLastLine: isUnterminated });
        this._onDidChangeTreeData.fire();

        if (isUnterminated && allowRetry) {
            this.scheduleRetry(varsPath);
        }
    }

    private scheduleRetry(varsPath: string): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.loadFromFile(varsPath, false);
        }, 75);
    }

    setFilter(query: string): void {
        this.filterQuery = query;
        this._onDidChangeTreeData.fire();
    }

    setSortMode(mode: VariableSortMode): void {
        this.sortMode = mode;
        this._onDidChangeTreeData.fire();
    }

    async promptFilterOrSort(): Promise<void> {
        const items: (vscode.QuickPickItem & { action: string })[] = [
            {
                label: '$(search) Filter variables\u2026',
                description: this.filterQuery ? `Current: "${this.filterQuery}"` : 'Match name, label, type, or format',
                action: 'filter',
            },
        ];
        if (this.filterQuery) {
            items.push({
                label: '$(clear-all) Clear filter',
                description: `Show all ${this.variables.length} variables`,
                action: 'clearFilter',
            });
        }
        items.push(
            {
                label: `${this.sortMode === 'order' ? '$(check) ' : ''}Sort: Dataset order`,
                description: 'Original Stata variable order',
                action: 'sortOrder',
            },
            {
                label: `${this.sortMode === 'name' ? '$(check) ' : ''}Sort: Name (A\u2013Z)`,
                description: 'Alphabetical by variable name',
                action: 'sortName',
            },
            {
                label: `${this.sortMode === 'type' ? '$(check) ' : ''}Sort: Type`,
                description: 'Group numeric, date/time, and string variables',
                action: 'sortType',
            },
        );

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Filter or sort Stata variables',
        });
        if (!picked) {
            return;
        }

        if (picked.action === 'filter') {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter variables by name, label, type, or format (leave empty to clear)',
                value: this.filterQuery,
                placeHolder: 'e.g. price, %td, str',
            });
            if (value !== undefined) {
                this.setFilter(value);
            }
        } else if (picked.action === 'clearFilter') {
            this.setFilter('');
        } else if (picked.action === 'sortOrder') {
            this.setSortMode('order');
        } else if (picked.action === 'sortName') {
            this.setSortMode('name');
        } else if (picked.action === 'sortType') {
            this.setSortMode('type');
        }
    }

    getTreeItem(node: VariablesTreeNode): vscode.TreeItem {
        if (isControlNode(node)) {
            const filteredCount = filterAndSortVariables(this.variables, this.filterQuery, this.sortMode).length;
            const hasActiveFilter = this.filterQuery.trim().length > 0;
            const sortBadge = this.sortMode === 'name' ? 'A\u2013Z' : this.sortMode === 'type' ? 'By type' : '';
            const parts: string[] = [];
            if (hasActiveFilter) {
                parts.push(`${filteredCount}/${this.variables.length} matching "${this.filterQuery.trim()}"`);
            } else {
                parts.push(`${this.variables.length} ${this.variables.length === 1 ? 'var' : 'vars'}`);
            }
            if (sortBadge) {
                parts.push(sortBadge);
            }

            const item = new vscode.TreeItem('Filter / Sort', vscode.TreeItemCollapsibleState.None);
            item.description = parts.join(' \u2022 ');
            item.iconPath = new vscode.ThemeIcon(hasActiveFilter || sortBadge ? 'filter-filled' : 'filter');
            item.tooltip = 'Click to filter or sort variables';
            item.command = {
                command: FILTER_SORT_CMD,
                title: 'Filter or Sort Variables',
            };
            return item;
        }

        const v = node;
        const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
        item.description = v.label || `${v.type} (${v.format})`;

        const mdLines = [
            `**${escapeMarkdown(v.name)}**`,
            `- Type: \`${v.type.replace(/`/g, '')}\``,
            `- Format: \`${v.format.replace(/`/g, '')}\``,
        ];
        if (v.label) {
            mdLines.push(`- Label: ${escapeMarkdown(v.label)}`);
        }
        const tooltip = new vscode.MarkdownString(mdLines.join('\n'));
        tooltip.isTrusted = false;
        tooltip.supportHtml = false;
        item.tooltip = tooltip;

        item.iconPath = this.getVariableIcon(v.type, v.format);
        item.command = {
            command: 'stata.insertVariable',
            title: 'Insert Variable',
            arguments: [v.name],
        };
        return item;
    }

    getChildren(): VariablesTreeNode[] {
        if (this.variables.length === 0) {
            return [];
        }
        const displayed = filterAndSortVariables(this.variables, this.filterQuery, this.sortMode);
        return [this.controlNode, ...displayed];
    }

    private getVariableIcon(type: string, format: string): vscode.ThemeIcon {
        const kind = classifyVariableKind(type, format);
        switch (kind) {
            case 'date':
                return new vscode.ThemeIcon('calendar');
            case 'string':
                return new vscode.ThemeIcon('symbol-string');
            case 'numeric':
                return new vscode.ThemeIcon('symbol-number');
            default:
                return new vscode.ThemeIcon('symbol-variable');
        }
    }

    dispose(): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (activeVariablesPanel === this) {
            activeVariablesPanel = undefined;
        }
        this._onDidChangeTreeData.dispose();
    }
}
