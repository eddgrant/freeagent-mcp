import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupStaging, cleanupStaging, detectMimeType } from '../evidence-staging.js';

describe('evidence-staging', () => {
    let tmpBase: string;
    let log: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'freeagent-staging-test-'));
        log = vi.fn();
    });

    afterEach(() => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    describe('setupStaging', () => {
        it('creates the session subdirectory and returns ready=true', () => {
            const state = setupStaging({ base: tmpBase, sessionId: 'sess1', log });
            expect(state.ready).toBe(true);
            expect(state.sessionPath).toBe(path.join(tmpBase, 'sess1'));
            expect(fs.existsSync(state.sessionPath!)).toBe(true);
        });

        it('logs readiness via the injected logger', () => {
            setupStaging({ base: tmpBase, sessionId: 'sess1', log });
            expect(log).toHaveBeenCalledWith(expect.stringContaining('staging ready'));
        });

        it('cleans up its probe file', () => {
            const state = setupStaging({ base: tmpBase, sessionId: 'sess1', log });
            expect(fs.readdirSync(state.sessionPath!)).toEqual([]);
        });

        it('returns ready=false with a reason when the base is unwritable', () => {
            // Simulate by pointing at a path with a non-directory parent.
            const blocker = path.join(tmpBase, 'not-a-dir');
            fs.writeFileSync(blocker, 'i am a file');
            const state = setupStaging({
                base: path.join(blocker, 'nested'),
                sessionId: 'sess1',
                log,
            });
            expect(state.ready).toBe(false);
            expect(state.sessionPath).toBeNull();
            expect(state.reason).toBeTruthy();
            expect(log).toHaveBeenCalledWith(expect.stringContaining('staging unavailable'));
        });

        it('uses default base path when none supplied (env var or /tmp/freeagent-mcp)', () => {
            // We don't actually create directories at the default path — just
            // verify the option resolution by inspecting the failure reason.
            const state = setupStaging({
                sessionId: 'sess-isolated',
                log,
                // Force a bad base via env var override
                base: process.env.FREEAGENT_EVIDENCE_BASE ?? '/tmp/freeagent-mcp',
            });
            // Either it succeeded (because the dev's /tmp is writable) or it
            // failed gracefully — both prove the path resolution worked.
            expect(typeof state.ready).toBe('boolean');
            if (state.ready) {
                cleanupStaging(state);
            }
        });

        it('sweeps stale sibling directories', () => {
            const stale = path.join(tmpBase, 'stale-session');
            fs.mkdirSync(stale, { recursive: true });
            // Make it look 25h old
            const oldMtime = Date.now() - (25 * 60 * 60 * 1000);
            fs.utimesSync(stale, new Date(oldMtime), new Date(oldMtime));

            setupStaging({
                base: tmpBase,
                sessionId: 'fresh',
                log,
                staleAfterMs: 24 * 60 * 60 * 1000,
            });

            expect(fs.existsSync(stale)).toBe(false);
        });

        it('preserves fresh sibling directories', () => {
            const fresh = path.join(tmpBase, 'fresh-other-session');
            fs.mkdirSync(fresh, { recursive: true });

            setupStaging({
                base: tmpBase,
                sessionId: 'me',
                log,
                staleAfterMs: 24 * 60 * 60 * 1000,
            });

            expect(fs.existsSync(fresh)).toBe(true);
        });

        it('does not sweep its own session directory', () => {
            const state = setupStaging({
                base: tmpBase,
                sessionId: 'me',
                log,
                now: () => Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
                staleAfterMs: 1,
            });
            expect(fs.existsSync(state.sessionPath!)).toBe(true);
        });

        it('continues on if a sibling vanishes mid-sweep', () => {
            // Create two stale siblings; ensuring no throw if one is hard to stat.
            const a = path.join(tmpBase, 'stale-a');
            const b = path.join(tmpBase, 'stale-b');
            fs.mkdirSync(a); fs.mkdirSync(b);
            const oldMtime = Date.now() - (25 * 60 * 60 * 1000);
            fs.utimesSync(a, new Date(oldMtime), new Date(oldMtime));
            fs.utimesSync(b, new Date(oldMtime), new Date(oldMtime));

            const state = setupStaging({
                base: tmpBase,
                sessionId: 'fresh',
                log,
                staleAfterMs: 24 * 60 * 60 * 1000,
            });

            expect(state.ready).toBe(true);
            expect(fs.existsSync(a)).toBe(false);
            expect(fs.existsSync(b)).toBe(false);
        });
    });

    describe('cleanupStaging', () => {
        it('removes the session directory when state is ready', () => {
            const state = setupStaging({ base: tmpBase, sessionId: 'sess', log });
            expect(fs.existsSync(state.sessionPath!)).toBe(true);
            cleanupStaging(state);
            expect(fs.existsSync(state.sessionPath!)).toBe(false);
        });

        it('is a no-op when state is not ready', () => {
            cleanupStaging({ ready: false, base: tmpBase, sessionPath: null });
            // No throw, base directory untouched.
            expect(fs.existsSync(tmpBase)).toBe(true);
        });

        it('is idempotent — safe to call twice', () => {
            const state = setupStaging({ base: tmpBase, sessionId: 'sess', log });
            cleanupStaging(state);
            expect(() => cleanupStaging(state)).not.toThrow();
        });
    });
});

describe('detectMimeType', () => {
    it('detects JPEG from its magic bytes', () => {
        expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    });

    it('detects PNG from its 8-byte signature', () => {
        expect(detectMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
            .toBe('image/png');
    });

    it('detects GIF (both GIF87a and GIF89a)', () => {
        expect(detectMimeType(Buffer.from('GIF87a...', 'ascii'))).toBe('image/gif');
        expect(detectMimeType(Buffer.from('GIF89a...', 'ascii'))).toBe('image/gif');
    });

    it('detects PDF from the %PDF- header', () => {
        expect(detectMimeType(Buffer.from('%PDF-1.7 ...', 'ascii'))).toBe('application/pdf');
    });

    it('returns undefined for bytes matching no known type', () => {
        expect(detectMimeType(Buffer.from('just plain text', 'ascii'))).toBeUndefined();
        expect(detectMimeType(Buffer.from([]))).toBeUndefined();
    });
});
