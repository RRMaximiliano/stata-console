const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    PlotHistoryStore,
    isValidPlotBuffer,
} = require('../out/plotHistoryStore.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function makeFakePng(payloadByte, payloadLength = 128) {
    return Buffer.concat([PNG_MAGIC, Buffer.alloc(payloadLength, payloadByte), PNG_IEND]);
}

test('isValidPlotBuffer rejects tiny or truncated mid-write PNG buffers', () => {
    assert.equal(isValidPlotBuffer(Buffer.alloc(50, 1)), false);
    const truncatedPng = Buffer.concat([PNG_MAGIC, Buffer.alloc(200, 0x41)]);
    assert.equal(isValidPlotBuffer(truncatedPng), false);
    assert.equal(isValidPlotBuffer(makeFakePng(0x41)), true);
});

test('PlotHistoryStore makes history durable immediately and deduplicates by content hash (not file size)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-plot-test-'));
    try {
        const store = new PlotHistoryStore();
        store.setTempDir(tmpDir);

        const sourceGraph = path.join(tmpDir, '_graph.png');
        const pngA = makeFakePng(0x11, 140);
        const pngB = makeFakePng(0x22, 140); // exact same byte size, different content!

        fs.writeFileSync(sourceGraph, pngA);
        const res1 = store.ingestFromGraphPanel(sourceGraph, tmpDir);
        assert.equal(res1.status, 'added');
        assert.equal(res1.index, 0);

        // Immediately following PlotsListPanel.addPlot call in same turn does not double-add
        const listRes1 = store.ingestFromPlotsList(sourceGraph);
        assert.equal(store.getPlots().length, 1);
        assert.equal(listRes1.index, 0);

        // Overwrite source _graph.png immediately — history copy must remain intact with pngA bytes
        fs.writeFileSync(sourceGraph, pngA);
        const dupRes = store.ingestFromGraphPanel(sourceGraph, tmpDir);
        assert.equal(dupRes.status, 'duplicate');
        assert.equal(store.getPlots().length, 1);

        // Different content of IDENTICAL file size must NOT be deduplicated
        fs.writeFileSync(sourceGraph, pngB);
        const res2 = store.ingestFromGraphPanel(sourceGraph, tmpDir);
        assert.equal(res2.status, 'added');
        assert.equal(store.getPlots().length, 2);
        assert.deepEqual(fs.readFileSync(store.getPlots()[0].historyPath), pngA);
        assert.deepEqual(fs.readFileSync(store.getPlots()[1].historyPath), pngB);

        // Non-consecutive repeat (A after B) IS recorded
        fs.writeFileSync(sourceGraph, pngA);
        const res3 = store.ingestFromGraphPanel(sourceGraph, tmpDir);
        assert.equal(res3.status, 'added');
        assert.equal(store.getPlots().length, 3);
        assert.equal(store.getCurrentIndex(), 2);

        // Delete middle plot (index 1) -> indices shift cleanly and currentIndex updates from 2 -> 1
        const middleHistoryFile = store.getPlots()[1].historyPath;
        store.deleteAt(1);
        assert.equal(fs.existsSync(middleHistoryFile), false);
        assert.equal(store.getPlots().length, 2);
        assert.equal(store.getCurrentIndex(), 1);

        // Clear removes all history copies and resets indices
        const remainingFiles = store.getPlots().map((p) => p.historyPath);
        store.clear();
        assert.equal(store.getPlots().length, 0);
        assert.equal(store.getCurrentIndex(), -1);
        for (const f of remainingFiles) {
            assert.equal(fs.existsSync(f), false);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
