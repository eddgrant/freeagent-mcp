// Stage a single evidence file in the per-session staging directory.
//
// Pure module — takes the staging path and optional random-suffix factory
// as deps, performs all filesystem work synchronously, and returns a
// discriminated result. The MCP tool wiring in src/index.ts converts the
// result into a tool response.
//
// The bytes pass through model context once (in this tool's input) and
// then live only on disk. Subsequent apply_reconciliations calls reference
// the returned path; bytes are not re-sent through context.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_BYTES = 5 * 1024 * 1024;
export const ALLOWED_CONTENT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/pdf',
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export interface StageEvidenceInput {
    data: string;            // base64-encoded bytes
    file_name: string;       // suggestion only — server sanitises and prefixes
    content_type: string;
}

export interface StageEvidenceResult {
    evidence_path: string;
    bytes_written: number;
    content_type: AllowedContentType;
}

export type StageEvidenceError =
    | { code: 'staging_volume_not_mounted' }
    | { code: 'invalid_base64' }
    | { code: 'unsupported_content_type'; provided: string; allowed: readonly string[] }
    | { code: 'too_large'; bytes: number; max: number }
    | { code: 'magic_byte_mismatch'; claimed: string; detected?: string }
    | { code: 'invalid_file_name'; reason: string }
    | { code: 'write_failed'; message: string };

export interface StageEvidenceDeps {
    /** Per-session staging path, or null when staging isn't mounted. */
    sessionPath: string | null;
    /** 12-hex-char unique-per-call collision-avoidance prefix. Default
     *  uses crypto.randomBytes(6); tests inject a deterministic value. */
    randomSuffix?: () => string;
}

type Outcome =
    | { ok: true; result: StageEvidenceResult }
    | { ok: false; error: StageEvidenceError };

export function stageEvidence(input: StageEvidenceInput, deps: StageEvidenceDeps): Outcome {
    if (!deps.sessionPath) {
        return { ok: false, error: { code: 'staging_volume_not_mounted' } };
    }

    if (!ALLOWED_CONTENT_TYPES.includes(input.content_type as AllowedContentType)) {
        return {
            ok: false,
            error: {
                code: 'unsupported_content_type',
                provided: input.content_type,
                allowed: ALLOWED_CONTENT_TYPES,
            },
        };
    }

    const decoded = decodeBase64(input.data);
    if (!decoded) return { ok: false, error: { code: 'invalid_base64' } };
    if (decoded.length > MAX_BYTES) {
        return { ok: false, error: { code: 'too_large', bytes: decoded.length, max: MAX_BYTES } };
    }

    const detected = detectMimeType(decoded);
    if (detected !== input.content_type) {
        return {
            ok: false,
            error: { code: 'magic_byte_mismatch', claimed: input.content_type, detected },
        };
    }

    const sanitised = sanitiseFileName(input.file_name);
    if (!sanitised.ok) {
        return { ok: false, error: { code: 'invalid_file_name', reason: sanitised.reason } };
    }

    const suffix = deps.randomSuffix
        ? deps.randomSuffix()
        : crypto.randomBytes(6).toString('hex');
    const finalName = `${suffix}-${sanitised.value}`;
    const finalPath = path.join(deps.sessionPath, finalName);
    const tmpPath = `${finalPath}.tmp`;

    try {
        fs.writeFileSync(tmpPath, decoded, { mode: 0o600 });
        fs.renameSync(tmpPath, finalPath);
    } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean */ }
        return { ok: false, error: { code: 'write_failed', message: (e as Error).message } };
    }

    return {
        ok: true,
        result: {
            evidence_path: finalPath,
            bytes_written: decoded.length,
            content_type: input.content_type as AllowedContentType,
        },
    };
}

function decodeBase64(s: string): Buffer | null {
    // Buffer.from with 'base64' is permissive — accepts garbage and silently
    // produces nonsense. Detect by round-tripping. Reject if the
    // canonicalised output doesn't match the input modulo padding/whitespace.
    if (typeof s !== 'string' || s.length === 0) return null;
    const cleaned = s.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
    if (cleaned.length % 4 !== 0) return null;
    try {
        const buf = Buffer.from(cleaned, 'base64');
        if (buf.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) return null;
        return buf;
    } catch {
        return null;
    }
}

export function detectMimeType(bytes: Buffer): AllowedContentType | undefined {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (bytes.length >= 6) {
        const head = bytes.subarray(0, 6).toString('ascii');
        if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    }
    if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
        return 'application/pdf';
    }
    return undefined;
}

interface SanitiseOk { ok: true; value: string }
interface SanitiseFail { ok: false; reason: string }

function sanitiseFileName(input: string): SanitiseOk | SanitiseFail {
    if (typeof input !== 'string' || input.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (input.includes('\0')) return { ok: false, reason: 'null_byte' };

    // Take only the basename — strips any directory part the agent supplied.
    let base = path.basename(input);
    if (base === '..' || base === '.') return { ok: false, reason: 'reserved' };

    // Allowlist: letters, digits, dot, underscore, hyphen.
    base = base.replace(/[^A-Za-z0-9._-]/g, '_');
    base = base.replace(/_+/g, '_');
    if (base.length > 64) base = base.substring(0, 64);
    if (base === '' || /^[._-]+$/.test(base)) return { ok: false, reason: 'all_chars_stripped' };

    return { ok: true, value: base };
}
