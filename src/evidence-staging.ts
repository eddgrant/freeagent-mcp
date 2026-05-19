// Per-session evidence staging directory for the reconciliation feature.
//
// On startup we create a session-scoped subdirectory under a base path
// (default: /tmp/freeagent-mcp), confirm we can write to it, and sweep
// stale sibling directories left behind by previous sessions that didn't
// shut down cleanly. On shutdown we remove our own subdirectory.
//
// The base path is intended to be bind-mounted from the host to the
// container at the same path on both sides so the agent and server agree
// on file locations. See TASKS.md ("Reconcile bank transactions (v1)")
// for context and SECURITY.md for the threat model.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StagingState {
    ready: boolean;
    /** Base path that holds all session subdirectories. */
    base: string;
    /** This session's subdirectory. Null when ready === false. */
    sessionPath: string | null;
    /** Populated when ready === false; suitable for surfacing to the agent. */
    reason?: string;
}

export interface SetupOptions {
    /** Override base path. Defaults to FREEAGENT_EVIDENCE_BASE env var,
     *  falling back to /tmp/freeagent-mcp. */
    base?: string;
    /** Override session id. Defaults to <pid>-<base36-timestamp>. */
    sessionId?: string;
    log?: (message: string) => void;
    now?: () => number;
    /** Stale-sibling threshold in ms. Defaults to 24h. */
    staleAfterMs?: number;
}

const DEFAULT_BASE = '/tmp/freeagent-mcp';
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function setupStaging(opts: SetupOptions = {}): StagingState {
    const log = opts.log ?? ((m: string) => console.error(m));
    const now = opts.now ?? Date.now;
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const base = opts.base ?? process.env.FREEAGENT_EVIDENCE_BASE ?? DEFAULT_BASE;
    const sessionId = opts.sessionId ?? `${process.pid}-${now().toString(36)}`;
    const sessionPath = path.join(base, sessionId);

    try {
        fs.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
        const probe = path.join(sessionPath, '.probe');
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        log(`[evidence] staging ready at ${sessionPath}`);

        sweepStaleSiblings({ base, sessionPath, now, staleAfterMs, log });

        return { ready: true, base, sessionPath };
    } catch (e) {
        const reason = (e as Error).message;
        log(`[evidence] staging unavailable: ${reason}`);
        log('[evidence] propose_reconciliations works; apply_reconciliations refuses attachments.');
        return { ready: false, base, sessionPath: null, reason };
    }
}

export function cleanupStaging(state: StagingState): void {
    if (!state.ready || !state.sessionPath) return;
    try {
        fs.rmSync(state.sessionPath, { recursive: true, force: true });
    } catch {
        // best effort — the next session's sweep will reap it.
    }
}

function sweepStaleSiblings(args: {
    base: string;
    sessionPath: string;
    now: () => number;
    staleAfterMs: number;
    log: (m: string) => void;
}): void {
    const { base, sessionPath, now, staleAfterMs, log } = args;
    let entries: string[];
    try {
        entries = fs.readdirSync(base);
    } catch (e) {
        log(`[evidence] sweep skipped: ${(e as Error).message}`);
        return;
    }
    for (const entry of entries) {
        const p = path.join(base, entry);
        if (p === sessionPath) continue;
        try {
            const stat = fs.statSync(p);
            if (now() - stat.mtimeMs > staleAfterMs) {
                fs.rmSync(p, { recursive: true, force: true });
            }
        } catch {
            // entry vanished mid-sweep, or permission glitch — ignore.
        }
    }
}

// =============================================================================
// Attachment-path validation
// Used when a file staged here is later read back to attach to a FreeAgent
// record (e.g. an expense receipt). Defence-in-depth against path traversal,
// symlinks, oversize files, and missing files.
// =============================================================================

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type PathValidation =
    | { ok: true; size: number }
    | { ok: false; reason: string };

/** Validate that `candidate` is a real, regular, in-bounds file under the
 *  session staging directory. The combination of (a) a prefix check after
 *  path.resolve and (b) lstat + isFile blocks traversal, symlinks, oversize
 *  files, and missing files. The trailing path.sep on the prefix check is
 *  load-bearing — without it, "<sid>FOO" would match "<sid>" as a prefix. */
export function validateEvidencePath(
    candidate: string,
    stagingPath: string | null,
): PathValidation {
    if (!stagingPath) return { ok: false, reason: 'staging_volume_not_mounted' };
    if (typeof candidate !== 'string' || candidate.length === 0) {
        return { ok: false, reason: 'empty_path' };
    }

    const resolved = path.resolve(candidate);
    const root = stagingPath.endsWith(path.sep) ? stagingPath : stagingPath + path.sep;
    if (!resolved.startsWith(root)) {
        return { ok: false, reason: `path_outside_staging:${stagingPath}` };
    }

    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(resolved);
    } catch {
        return { ok: false, reason: 'file_not_found' };
    }

    if (!stat.isFile()) return { ok: false, reason: 'not_a_regular_file' };
    if (stat.size > MAX_ATTACHMENT_BYTES) {
        return { ok: false, reason: `too_large:${stat.size}` };
    }

    return { ok: true, size: stat.size };
}

// =============================================================================
// Content-type detection
// Verifies a staged file's real type from its magic bytes — used to check the
// caller's declared content_type before the file is attached to FreeAgent.
// =============================================================================

export const ALLOWED_CONTENT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/pdf',
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** Detect the MIME type of `bytes` from its magic numbers. Returns one of the
 *  allowed content types, or undefined if the bytes match none of them. */
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
