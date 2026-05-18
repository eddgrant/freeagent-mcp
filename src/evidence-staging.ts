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
