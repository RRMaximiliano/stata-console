import { isStataMissingToken, parseStrictNumber } from './dataUtils';

export interface StataVariableInfo {
    name: string;
    type: string;
    format: string;
    label: string;
}

export type VariableKind = 'date' | 'string' | 'numeric' | 'other';
export type VariableSortMode = 'order' | 'name' | 'type';

export type StoredResultCategory = 'e_scalars' | 'e_macros' | 'r_scalars' | 'r_macros';

export interface StoredResultItem {
    type: 'e' | 'em' | 'r' | 'rm';
    category: StoredResultCategory;
    name: string;
    accessor: string;
    value: string;
    formattedValue: string;
    isScalar: boolean;
}

export interface StoredResultGroup {
    id: StoredResultCategory;
    label: string;
    icon: string;
    items: StoredResultItem[];
}

export interface TsvParseOptions {
    /**
     * When true and `content` does not end with `\n`, drop the final line
     * because Stata's `file write ... _n` always terminates complete lines with `\n`.
     */
    dropUnterminatedLastLine?: boolean;
}

const NUMERIC_TYPES_RE = /^(?:byte|int|long|float|double)$/i;
const STRING_TYPES_RE = /^str(?:\d+|L)$/i;
// Stata date/time display formats: %tc, %tC, %td, %-td, %tw, %tm, %tq, %th, %ty, %tg, and legacy %d / %-d
const DATE_FORMAT_RE = /^%-?(?:t[cCdwmqhyg]|d)/;

function splitTsvLines(content: string, options?: TsvParseOptions): string[] {
    const clean = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (!clean) {
        return [];
    }
    const endsWithNewline = clean.endsWith('\n') || clean.endsWith('\r');
    const rawLines = clean.split(/\r\n|\n|\r/);
    if (endsWithNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
    } else if (!endsWithNewline && options?.dropUnterminatedLastLine && rawLines.length > 0) {
        rawLines.pop();
    }
    return rawLines;
}

/**
 * Parse `_vars.tsv` (`name\ttype\tformat\tlabel`).
 * Tolerates missing/empty files, CRLF, BOM, and truncated mid-write lines without throwing.
 */
export function parseVarsTsv(content: string, options?: TsvParseOptions): StataVariableInfo[] {
    const lines = splitTsvLines(content, options);
    if (lines.length <= 1) {
        return [];
    }

    const headerParts = lines[0].split('\t').map((s) => s.trim().toLowerCase());
    if (headerParts[0] !== 'name') {
        return [];
    }

    const vars: StataVariableInfo[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
            continue;
        }
        const parts = line.split('\t');
        // Stata writes 4 tab-separated columns: name, type, format, label.
        // Fewer than 4 columns indicates a truncated mid-write line (unless label tab was omitted in manual input with >=3 valid fields).
        if (parts.length < 3) {
            continue;
        }
        const name = (parts[0] || '').trim();
        const type = (parts[1] || '').trim();
        const format = (parts[2] || '').trim();
        const label = parts.slice(3).join('\t').trim();

        if (!name || !type || !format.startsWith('%')) {
            continue;
        }

        vars.push({ name, type, format, label });
    }

    return vars;
}

export function classifyVariableKind(type: string, format: string): VariableKind {
    if (DATE_FORMAT_RE.test(format.trim())) {
        return 'date';
    }
    if (STRING_TYPES_RE.test(type.trim()) || /^str/i.test(type.trim())) {
        return 'string';
    }
    if (NUMERIC_TYPES_RE.test(type.trim())) {
        return 'numeric';
    }
    return 'other';
}

export function filterAndSortVariables(
    variables: readonly StataVariableInfo[],
    filterQuery: string,
    sortMode: VariableSortMode,
): StataVariableInfo[] {
    const q = filterQuery.trim().toLowerCase();
    const filtered = q
        ? variables.filter((v) =>
            v.name.toLowerCase().includes(q) ||
            v.label.toLowerCase().includes(q) ||
            v.type.toLowerCase().includes(q) ||
            v.format.toLowerCase().includes(q))
        : variables.slice();

    if (sortMode === 'name') {
        filtered.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } else if (sortMode === 'type') {
        const rank: Record<VariableKind, number> = { numeric: 0, date: 1, string: 2, other: 3 };
        filtered.sort((a, b) => {
            const diff = rank[classifyVariableKind(a.type, a.format)] - rank[classifyVariableKind(b.type, b.format)];
            if (diff !== 0) {
                return diff;
            }
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
    }

    return filtered;
}

/**
 * Format a Stata stored result value nicely for sidebar display.
 * Scalars get clean numeric formatting; macros stay untouched text (never coerced via parseFloat).
 */
export function formatStoredResultValue(rawValue: string, isScalar: boolean): string {
    const trimmed = rawValue.trim();
    if (!isScalar) {
        const normalized = trimmed.replace(/\s+/g, ' ');
        return normalized || '(empty)';
    }

    if (trimmed === '') {
        return '(empty)';
    }
    if (isStataMissingToken(trimmed)) {
        return trimmed;
    }

    const num = parseStrictNumber(trimmed);
    if (num === null) {
        return trimmed;
    }
    if (Object.is(num, -0) || num === 0) {
        return '0';
    }

    const abs = Math.abs(num);
    if (abs >= 1e12 || abs < 1e-4) {
        // Compact scientific notation without trailing zeros in mantissa, e.g. 2.345e-8
        const expStr = num.toExponential(4);
        const [mantissa, exponent] = expStr.split('e');
        const cleanMantissa = mantissa.replace(/\.?0+$/, '');
        const cleanExp = exponent.replace(/^\+/, '');
        return `${cleanMantissa}e${cleanExp}`;
    }

    if (Number.isInteger(num)) {
        return num.toLocaleString('en-US');
    }

    // Up to 6 significant digits without insignificant trailing zeros
    const sig = Number(num.toPrecision(6));
    if (Math.abs(sig) >= 1000) {
        const parts = sig.toString().split('.');
        const intPart = Number(parts[0]).toLocaleString('en-US');
        return parts.length > 1 ? `${intPart}.${parts[1]}` : intPart;
    }
    return sig.toString();
}

/**
 * Parse `_results.tsv` (`type\tname\tvalue`, where type is `e`, `em`, `r`, or `rm`)
 * and group into `e() Scalars`, `e() Macros`, `r() Scalars`, and `r() Macros`.
 */
export function parseResultsTsv(content: string, options?: TsvParseOptions): StoredResultGroup[] {
    const lines = splitTsvLines(content, options);
    if (lines.length <= 1) {
        return [];
    }

    const headerParts = lines[0].split('\t').map((s) => s.trim().toLowerCase());
    if (headerParts[0] !== 'type') {
        return [];
    }

    const buckets: Record<StoredResultCategory, StoredResultItem[]> = {
        e_scalars: [],
        e_macros: [],
        r_scalars: [],
        r_macros: [],
    };

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
            continue;
        }
        const parts = line.split('\t');
        // Must have at least 3 tab-separated columns (type, name, value) to not be truncated mid-key
        if (parts.length < 3) {
            continue;
        }
        const rawType = (parts[0] || '').trim();
        const name = (parts[1] || '').trim();
        const value = parts.slice(2).join('\t').trim();

        if (!name) {
            continue;
        }

        if (rawType === 'e') {
            buckets.e_scalars.push({
                type: 'e',
                category: 'e_scalars',
                name,
                accessor: `e(${name})`,
                value,
                formattedValue: formatStoredResultValue(value, true),
                isScalar: true,
            });
        } else if (rawType === 'em') {
            buckets.e_macros.push({
                type: 'em',
                category: 'e_macros',
                name,
                accessor: `e(${name})`,
                value,
                formattedValue: formatStoredResultValue(value, false),
                isScalar: false,
            });
        } else if (rawType === 'r') {
            buckets.r_scalars.push({
                type: 'r',
                category: 'r_scalars',
                name,
                accessor: `r(${name})`,
                value,
                formattedValue: formatStoredResultValue(value, true),
                isScalar: true,
            });
        } else if (rawType === 'rm') {
            buckets.r_macros.push({
                type: 'rm',
                category: 'r_macros',
                name,
                accessor: `r(${name})`,
                value,
                formattedValue: formatStoredResultValue(value, false),
                isScalar: false,
            });
        }
    }

    const definitions: { id: StoredResultCategory; label: string; icon: string }[] = [
        { id: 'e_scalars', label: 'e() Scalars', icon: 'symbol-number' },
        { id: 'e_macros', label: 'e() Macros', icon: 'symbol-string' },
        { id: 'r_scalars', label: 'r() Scalars', icon: 'symbol-number' },
        { id: 'r_macros', label: 'r() Macros', icon: 'symbol-string' },
    ];

    const groups: StoredResultGroup[] = [];
    for (const def of definitions) {
        if (buckets[def.id].length > 0) {
            groups.push({
                id: def.id,
                label: def.label,
                icon: def.icon,
                items: buckets[def.id],
            });
        }
    }

    return groups;
}
