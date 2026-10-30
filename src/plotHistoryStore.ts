import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PlotRecord {
    id: number;
    historyPath: string;
    hash: string;
    timestamp: Date;
}

export type IngestStatus = 'added' | 'duplicate' | 'invalid';

export interface IngestResult {
    status: IngestStatus;
    index: number;
    record?: PlotRecord;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function computeContentHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validate that an image buffer is non-trivial (>= 100 bytes) and, if it starts
 * with a PNG signature, ends with a complete PNG IEND chunk (not mid-write).
 */
export function isValidPlotBuffer(buffer: Buffer): boolean {
    if (buffer.length < 100) {
        return false;
    }
    if (buffer.subarray(0, 8).equals(PNG_MAGIC)) {
        // PNG ends with 12-byte IEND chunk (occasionally followed by trailing whitespace/zeros is not valid PNG)
        const tail = buffer.subarray(buffer.length - 12);
        return tail.equals(PNG_IEND);
    }
    return true;
}

/**
 * Shared durable plot history store keeping GraphPanel and PlotsListPanel
 * synchronized on plot count, file paths, deduplication, clear, and delete.
 */
export class PlotHistoryStore {
    private plots: PlotRecord[] = [];
    private currentIndex = -1;
    private plotCounter = 0;
    private tempDir = '';
    private listeners = new Set<() => void>();
    private lastGraphPanelSource: string | null = null;

    setTempDir(tempDir: string): void {
        this.tempDir = tempDir;
    }

    getTempDir(): string {
        return this.tempDir;
    }

    getPlots(): readonly PlotRecord[] {
        return this.plots;
    }

    getCurrentIndex(): number {
        return this.currentIndex;
    }

    getCurrentPlot(): PlotRecord | undefined {
        if (this.currentIndex >= 0 && this.currentIndex < this.plots.length) {
            return this.plots[this.currentIndex];
        }
        return undefined;
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emitChange(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    /**
     * Ingest a newly detected graph file from GraphPanel.show().
     * Reads bytes synchronously, validates completeness, deduplicates consecutive identical
     * content hashes, and writes a durable history copy BEFORE updating state or rendering.
     */
    ingestFromGraphPanel(sourcePath: string, tempDir?: string): IngestResult {
        if (tempDir) {
            this.tempDir = tempDir;
        }
        const resolved = sourcePath ? path.resolve(sourcePath) : null;
        this.lastGraphPanelSource = resolved;
        if (resolved) {
            queueMicrotask(() => {
                if (this.lastGraphPanelSource === resolved) {
                    this.lastGraphPanelSource = null;
                }
            });
        }
        return this.ingestInternal(sourcePath, this.tempDir);
    }

    /**
     * Called by PlotsListPanel.addPlot().
     * In `extension.ts`, `graphPanel.show(p)` is immediately followed by `plotsListPanel.addPlot(p)`.
     * If `ingestFromGraphPanel` already processed `p`, consume that marker without double-adding;
     * otherwise ingest directly so `PlotsListPanel` also works standalone.
     */
    ingestFromPlotsList(sourcePath: string): IngestResult {
        const resolved = sourcePath ? path.resolve(sourcePath) : '';
        if (resolved && this.lastGraphPanelSource === resolved) {
            this.lastGraphPanelSource = null;
            return {
                status: 'duplicate',
                index: this.currentIndex,
                record: this.getCurrentPlot(),
            };
        }
        return this.ingestInternal(sourcePath, this.tempDir);
    }

    private ingestInternal(sourcePath: string, copyDir: string): IngestResult {
        if (!sourcePath) {
            return { status: 'invalid', index: this.currentIndex };
        }

        let buffer: Buffer;
        try {
            buffer = fs.readFileSync(sourcePath);
        } catch {
            return { status: 'invalid', index: this.currentIndex };
        }

        if (!isValidPlotBuffer(buffer)) {
            return { status: 'invalid', index: this.currentIndex };
        }

        const hash = computeContentHash(buffer);
        const lastPlot = this.plots.length > 0 ? this.plots[this.plots.length - 1] : undefined;
        if (lastPlot && lastPlot.hash === hash && fs.existsSync(lastPlot.historyPath)) {
            return {
                status: 'duplicate',
                index: this.plots.length - 1,
                record: lastPlot,
            };
        }

        const id = ++this.plotCounter;
        let historyPath = sourcePath;
        if (copyDir) {
            const targetPath = path.join(copyDir, `_plot_${id}.png`);
            try {
                fs.writeFileSync(targetPath, buffer);
                historyPath = targetPath;
            } catch {
                return { status: 'invalid', index: this.currentIndex };
            }
        }

        const record: PlotRecord = {
            id,
            historyPath,
            hash,
            timestamp: new Date(),
        };
        this.plots.push(record);
        this.currentIndex = this.plots.length - 1;
        this.emitChange();
        return {
            status: 'added',
            index: this.currentIndex,
            record,
        };
    }

    setCurrentIndex(index: number): PlotRecord | undefined {
        if (index < 0 || index >= this.plots.length) {
            return undefined;
        }
        const target = this.plots[index];
        if (!fs.existsSync(target.historyPath)) {
            return undefined;
        }
        if (this.currentIndex !== index) {
            this.currentIndex = index;
            this.emitChange();
        }
        return target;
    }

    prev(): PlotRecord | undefined {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            if (fs.existsSync(this.plots[i].historyPath)) {
                this.currentIndex = i;
                this.emitChange();
                return this.plots[i];
            }
        }
        return undefined;
    }

    next(): PlotRecord | undefined {
        for (let i = this.currentIndex + 1; i < this.plots.length; i++) {
            if (fs.existsSync(this.plots[i].historyPath)) {
                this.currentIndex = i;
                this.emitChange();
                return this.plots[i];
            }
        }
        return undefined;
    }

    deleteAt(index: number): PlotRecord | undefined {
        if (index < 0 || index >= this.plots.length) {
            return undefined;
        }
        const [removed] = this.plots.splice(index, 1);
        this.tryCleanupHistoryFile(removed.historyPath);

        if (this.plots.length === 0) {
            this.currentIndex = -1;
        } else if (this.currentIndex > index) {
            this.currentIndex--;
        } else if (this.currentIndex >= this.plots.length) {
            this.currentIndex = this.plots.length - 1;
        }

        this.emitChange();
        return this.getCurrentPlot();
    }

    clear(): void {
        const hadPlots = this.plots.length > 0 || this.currentIndex !== -1;
        for (const plot of this.plots) {
            this.tryCleanupHistoryFile(plot.historyPath);
        }
        this.plots = [];
        this.currentIndex = -1;
        this.plotCounter = 0;
        this.lastGraphPanelSource = null;
        if (hadPlots) {
            this.emitChange();
        }
    }

    private tryCleanupHistoryFile(filePath: string): void {
        if (!this.tempDir) {
            return;
        }
        // Only unlink files that we created inside tempDir as `_plot_*.png`
        const base = path.basename(filePath);
        if (!/^_plot_\d+\.png$/i.test(base)) {
            return;
        }
        const resolvedDir = path.resolve(this.tempDir);
        const resolvedFile = path.resolve(filePath);
        if (path.dirname(resolvedFile) !== resolvedDir) {
            return;
        }
        try {
            if (fs.existsSync(resolvedFile)) {
                fs.unlinkSync(resolvedFile);
            }
        } catch {
            // Best-effort cleanup
        }
    }
}

export const sharedPlotHistoryStore = new PlotHistoryStore();
