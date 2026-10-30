/**
 * Terminal input parsing and single-line editing for the pseudoterminal.
 * Handles pasted multi-line text, Windows/macOS/Linux backspace and Enter
 * variants, cursor movement and Home/End/Ctrl+A/E/U/K. No `vscode` dependency.
 */
export type InputKey =
    | 'enter' | 'backspace' | 'delete' | 'left' | 'right' | 'up' | 'down'
    | 'home' | 'end' | 'interrupt' | 'kill-line' | 'kill-to-end' | 'kill-word';

export type InputEvent =
    | { type: 'text'; text: string }
    | { type: 'key'; key: InputKey };

const ESC = String.fromCharCode(27);
const escape = (pattern: string) => new RegExp(`^${ESC}${pattern}`);

const ESCAPE_KEYS: [RegExp, InputKey | null][] = [
    [escape('\\[(?:\\d+;)?\\d*A'), 'up'],
    [escape('\\[(?:\\d+;)?\\d*B'), 'down'],
    [escape('\\[(?:\\d+;)?\\d*C'), 'right'],
    [escape('\\[(?:\\d+;)?\\d*D'), 'left'],
    [escape('\\[(?:1;\\d)?H'), 'home'],
    [escape('\\[(?:1;\\d)?F'), 'end'],
    [escape('\\[[17]~'), 'home'],
    [escape('\\[[48]~'), 'end'],
    [escape('\\[3~'), 'delete'],
    [escape('O[HF]'), null],
    [escape('\\[20[01]~'), null],
];
const UNKNOWN_ESCAPE_RE = escape('(?:\\[[0-9;?]*[ -/]*[@-~]|O.|.)');

/** Split a raw `handleInput` chunk into text runs and key presses. */
export function parseInput(data: string): InputEvent[] {
    const events: InputEvent[] = [];
    let text = '';
    const flush = () => {
        if (text) {
            events.push({ type: 'text', text });
            text = '';
        }
    };
    const key = (k: InputKey) => {
        flush();
        events.push({ type: 'key', key: k });
    };

    let i = 0;
    while (i < data.length) {
        const ch = data[i];

        if (ch === ESC) {
            const rest = data.slice(i);
            const hit = ESCAPE_KEYS.find(([re]) => re.test(rest));
            if (hit) {
                const len = (rest.match(hit[0]) as RegExpMatchArray)[0].length;
                if (hit[1]) { key(hit[1]); }
                else if (rest.startsWith(`${ESC}OH`)) { key('home'); }
                else if (rest.startsWith(`${ESC}OF`)) { key('end'); }
                i += len;
                continue;
            }
            if (rest.startsWith(`${ESC}\x7f`) || rest.startsWith(`${ESC}\b`)) {
                key('kill-word');
                i += 2;
                continue;
            }
            // Unknown escape sequence: skip ESC [ ... final byte
            const seq = rest.match(UNKNOWN_ESCAPE_RE);
            i += seq ? seq[0].length : 1;
            continue;
        }

        switch (ch) {
            case '\r':
                key('enter');
                if (data[i + 1] === '\n') { i++; }
                break;
            case '\n':
                key('enter');
                break;
            case '\x7f':
            case '\b':
                key('backspace');
                break;
            case '\x03':
                key('interrupt');
                break;
            case '\x01':
                key('home');
                break;
            case '\x05':
                key('end');
                break;
            case '\x15':
                key('kill-line');
                break;
            case '\x0b':
                key('kill-to-end');
                break;
            case '\x17':
                key('kill-word');
                break;
            case '\t':
                text += '    ';
                break;
            default:
                // Drop other control characters
                if (ch >= ' ') { text += ch; }
        }
        i++;
    }
    flush();
    return events;
}

/** Editable single line with a cursor. Methods return terminal output. */
export class LineEditor {
    private chars: string[] = [];
    private pos = 0;
    /** Colored prompt used when the line has to be redrawn. */
    prompt = '';

    get text(): string {
        return this.chars.join('');
    }

    get isEmpty(): boolean {
        return this.chars.length === 0;
    }

    clear(): void {
        this.chars = [];
        this.pos = 0;
    }

    insert(text: string): string {
        const inserted = Array.from(text);
        const atEnd = this.pos === this.chars.length;
        this.chars.splice(this.pos, 0, ...inserted);
        this.pos += inserted.length;
        return atEnd ? text : this.redraw();
    }

    backspace(): string {
        if (this.pos === 0) { return ''; }
        const atEnd = this.pos === this.chars.length;
        this.chars.splice(--this.pos, 1);
        return atEnd ? '\b \b' : this.redraw();
    }

    delete(): string {
        if (this.pos >= this.chars.length) { return ''; }
        this.chars.splice(this.pos, 1);
        return this.redraw();
    }

    left(): string {
        if (this.pos === 0) { return ''; }
        this.pos--;
        return '\x1b[D';
    }

    right(): string {
        if (this.pos >= this.chars.length) { return ''; }
        this.pos++;
        return '\x1b[C';
    }

    home(): string {
        if (this.pos === 0) { return ''; }
        const n = this.pos;
        this.pos = 0;
        return `\x1b[${n}D`;
    }

    end(): string {
        const n = this.chars.length - this.pos;
        if (n === 0) { return ''; }
        this.pos = this.chars.length;
        return `\x1b[${n}C`;
    }

    killLine(): string {
        this.clear();
        return this.redraw();
    }

    killToEnd(): string {
        this.chars.length = this.pos;
        return this.redraw();
    }

    killWord(): string {
        let start = this.pos;
        while (start > 0 && this.chars[start - 1] === ' ') { start--; }
        while (start > 0 && this.chars[start - 1] !== ' ') { start--; }
        this.chars.splice(start, this.pos - start);
        this.pos = start;
        return this.redraw();
    }

    /** Replace the whole line (history recall) with the cursor at the end. */
    set(text: string): string {
        this.chars = Array.from(text);
        this.pos = this.chars.length;
        return this.redraw();
    }

    /** Redraw prompt and line, leaving the cursor at its logical position. */
    redraw(): string {
        const back = this.chars.length - this.pos;
        return `\r\x1b[2K${this.prompt}${this.text}${back > 0 ? `\x1b[${back}D` : ''}`;
    }
}
