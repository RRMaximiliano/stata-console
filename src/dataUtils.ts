export interface CsvParseResult {
    headers: string[];
    rows: string[][];
    totalDataRows: number;
}

export interface PreparedCsvTable {
    headers: string[];
    rows: string[][];
    numericCols: boolean[];
    showing: number;
    total: number;
    truncated: boolean;
    shapeKey: string;
}

const STRICT_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const EXTENDED_MISSING_RE = /^\.[a-z]$/;

/**
 * RFC-4180 compliant CSV parser supporting UTF-8 BOM, CRLF/LF/CR line endings,
 * escaped quotes (`""`), and embedded commas/quotes/newlines inside quoted fields.
 * Stops allocating data rows once `maxDataRows` is reached while still counting
 * total data records in the stream.
 */
export function parseCsv(content: string, maxDataRows = Infinity): CsvParseResult {
    const src = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (src.length === 0) {
        return { headers: [], rows: [], totalDataRows: 0 };
    }

    let headers: string[] | null = null;
    let headerColCount = 0;
    const rows: string[][] = [];
    let totalDataRows = 0;

    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let fieldStarted = false;
    let collecting = true;

    const commitRecord = (): void => {
        if (headers === null) {
            headers = currentRow;
            headerColCount = currentRow.length;
            collecting = maxDataRows > 0;
        } else {
            totalDataRows++;
            if (collecting) {
                rows.push(currentRow);
                if (rows.length >= maxDataRows) {
                    collecting = false;
                }
            }
        }
        currentRow = [];
        currentField = '';
        fieldStarted = false;
    };

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (ch === '"') {
            if (inQuotes) {
                if (src[i + 1] === '"') {
                    if (headers === null || collecting) {
                        currentField += '"';
                    }
                    i++;
                } else {
                    inQuotes = false;
                }
            } else if (!fieldStarted && currentField.length === 0) {
                inQuotes = true;
                fieldStarted = true;
            } else {
                // Unquoted field containing literal quote
                if (headers === null || collecting) {
                    currentField += ch;
                }
                fieldStarted = true;
            }
        } else if (ch === ',' && !inQuotes) {
            if (headers === null || collecting) {
                currentRow.push(currentField);
                currentField = '';
            }
            fieldStarted = false;
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && src[i + 1] === '\n') {
                i++;
            }
            if ((headers === null || headerColCount > 1) && currentRow.length === 0 && currentField === '' && !fieldStarted) {
                continue;
            }
            if (headers === null || collecting) {
                currentRow.push(currentField);
            }
            commitRecord();
        } else {
            if (headers === null || collecting) {
                currentField += ch;
            }
            fieldStarted = true;
        }
    }

    if (currentRow.length > 0 || currentField.length > 0 || fieldStarted) {
        if (headers === null || collecting) {
            currentRow.push(currentField);
        }
        commitRecord();
    }

    return {
        headers: headers ?? [],
        rows,
        totalDataRows,
    };
}

export function isStataMissingToken(value: string): boolean {
    const trimmed = value.trim();
    return trimmed === '.' || EXTENDED_MISSING_RE.test(trimmed);
}

/**
 * Returns missing rank >= 0 for empty or Stata missing values (`.` / `.a`-`.z`), or -1 otherwise.
 * Order among missing values: `""` (0) < `.` (1) < `.a` (2) < ... < `.z` (27).
 */
export function getStataMissingRank(value: string): number {
    const trimmed = value.trim();
    if (trimmed === '') {
        return 0;
    }
    if (trimmed === '.') {
        return 1;
    }
    if (EXTENDED_MISSING_RE.test(trimmed)) {
        return 2 + (trimmed.charCodeAt(1) - 97);
    }
    return -1;
}

export function parseStrictNumber(value: string): number | null {
    const trimmed = value.trim();
    if (!STRICT_NUMBER_RE.test(trimmed)) {
        return null;
    }
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
}

/**
 * Compare two Stata cell values for sorting.
 * - Stata missing values (`""`, `.`, `.a`–`.z`) always sort last (in both ascending and descending modes),
 *   ordered `. < .a < ... < .z` among themselves.
 * - Strict numbers (including numbers stored as text) compare numerically.
 * - Strings compare lexicographically (case-insensitive primary, exact tie-breaker).
 * - If a column mixes numbers and text (e.g. partial value labels), numbers precede text labels in ascending order.
 */
export function compareStataValues(a: string, b: string, ascending = true): number {
    const missA = getStataMissingRank(a);
    const missB = getStataMissingRank(b);
    if (missA >= 0 || missB >= 0) {
        if (missA >= 0 && missB >= 0) {
            return missA - missB;
        }
        return missA >= 0 ? 1 : -1;
    }

    const numA = parseStrictNumber(a);
    const numB = parseStrictNumber(b);

    let cmp: number;
    if (numA !== null && numB !== null) {
        cmp = numA < numB ? -1 : numA > numB ? 1 : 0;
    } else if (numA !== null && numB === null) {
        cmp = -1;
    } else if (numA === null && numB !== null) {
        cmp = 1;
    } else {
        const lowerA = a.toLowerCase();
        const lowerB = b.toLowerCase();
        if (lowerA !== lowerB) {
            cmp = lowerA < lowerB ? -1 : 1;
        } else {
            cmp = a < b ? -1 : a > b ? 1 : 0;
        }
    }

    return ascending ? cmp : -cmp;
}

export function detectNumericColumns(headers: readonly string[], rows: readonly string[][]): boolean[] {
    const sampleLimit = Math.min(rows.length, 200);
    return headers.map((_, ci) => {
        let numericCount = 0;
        let nonMissingCount = 0;
        for (let ri = 0; ri < sampleLimit; ri++) {
            const val = rows[ri]?.[ci] ?? '';
            if (getStataMissingRank(val) >= 0) {
                continue;
            }
            nonMissingCount++;
            if (parseStrictNumber(val) !== null) {
                numericCount++;
            }
        }
        return nonMissingCount > 0 && numericCount === nonMissingCount;
    });
}

export function prepareCsvTable(content: string, rowLimit: number, totalObsHint?: number): PreparedCsvTable {
    const safeLimit = Math.max(1, Math.floor(Number.isFinite(rowLimit) ? rowLimit : 10000));
    const parsed = parseCsv(content, safeLimit);
    const { headers } = parsed;
    if (headers.length === 0) {
        return {
            headers: [],
            rows: [],
            numericCols: [],
            showing: 0,
            total: 0,
            truncated: false,
            shapeKey: '',
        };
    }

    const colCount = headers.length;
    const rows = parsed.rows.map((row) => {
        if (row.length === colCount) {
            return row;
        }
        if (row.length > colCount) {
            return row.slice(0, colCount);
        }
        const padded = row.slice();
        while (padded.length < colCount) {
            padded.push('');
        }
        return padded;
    });

    const numericCols = detectNumericColumns(headers, rows);
    const showing = rows.length;
    const hinted = typeof totalObsHint === 'number' && Number.isFinite(totalObsHint) && totalObsHint >= 0
        ? Math.floor(totalObsHint)
        : undefined;
    const total = Math.max(showing, parsed.totalDataRows, hinted ?? 0);
    const truncated = showing < total;
    const shapeKey = headers.join('\u0000');

    return {
        headers,
        rows,
        numericCols,
        showing,
        total,
        truncated,
        shapeKey,
    };
}
