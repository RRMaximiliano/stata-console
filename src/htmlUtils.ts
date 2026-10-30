import * as crypto from 'crypto';

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

export function createNonce(): string {
    return crypto.randomBytes(18).toString('base64');
}

/**
 * Safely serialize data into JSON suitable for embedding inside an HTML <script> block.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 so untrusted strings cannot break out of `<script>`.
 */
export function serializeJsonForHtml(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Validate external URLs for links (e.g. SMCL `{browse ...}`).
 * Allows only http://, https://, and mailto: URLs; blocks javascript:, command:, vscode:, data:, file:, etc.
 */
export function sanitizeExternalUrl(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return null;
    }
    // Reject ASCII control characters and whitespace inside scheme
    for (let i = 0; i < trimmed.length; i++) {
        const code = trimmed.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) {
            return null;
        }
    }
    if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
        return trimmed;
    }
    if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(trimmed)) {
        return trimmed;
    }
    return null;
}

/**
 * Extract filename from either a Windows (`C:\dir\file.dta`) or POSIX (`/dir/file.dta`) path
 * regardless of the host OS.
 */
export function crossPlatformBasename(filePath: string): string {
    const trimmed = filePath.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}
