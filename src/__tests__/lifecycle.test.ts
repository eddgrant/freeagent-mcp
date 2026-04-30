import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installLifecycleHandlers } from '../lifecycle.js';

// Helper: build a fully-stubbed lifecycle environment so tests don't touch
// the real process / stdin / exit. The settle() helper drains microtasks so
// the async shutdown callback can complete before assertions.
function makeEnv() {
    const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const signals = new EventEmitter();
    const exit = vi.fn();
    const log = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);

    installLifecycleHandlers({
        server: { close },
        stdin,
        signals,
        exit,
        log,
    });

    return { stdin, signals, exit, close, log };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('installLifecycleHandlers', () => {
    it('shuts down cleanly on SIGINT', async () => {
        const env = makeEnv();
        env.signals.emit('SIGINT');
        await settle();
        expect(env.close).toHaveBeenCalledOnce();
        expect(env.exit).toHaveBeenCalledWith(0);
        expect(env.log).toHaveBeenCalledWith(expect.stringContaining('SIGINT'));
    });

    it('shuts down cleanly on SIGTERM (the signal `docker stop` sends)', async () => {
        const env = makeEnv();
        env.signals.emit('SIGTERM');
        await settle();
        expect(env.close).toHaveBeenCalledOnce();
        expect(env.exit).toHaveBeenCalledWith(0);
        expect(env.log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
    });

    it("shuts down when stdin emits 'end' (MCP client disconnected)", async () => {
        const env = makeEnv();
        (env.stdin as unknown as EventEmitter).emit('end');
        await settle();
        expect(env.close).toHaveBeenCalledOnce();
        expect(env.exit).toHaveBeenCalledWith(0);
    });

    it("shuts down when stdin emits 'close'", async () => {
        const env = makeEnv();
        (env.stdin as unknown as EventEmitter).emit('close');
        await settle();
        expect(env.close).toHaveBeenCalledOnce();
        expect(env.exit).toHaveBeenCalledWith(0);
    });

    it('only shuts down once when multiple signals arrive in quick succession', async () => {
        const env = makeEnv();
        // Realistic case: docker stop sends SIGTERM, then the SDK fires its
        // stdin 'end' shortly after as the connection unwinds.
        env.signals.emit('SIGTERM');
        (env.stdin as unknown as EventEmitter).emit('end');
        env.signals.emit('SIGINT');
        await settle();
        expect(env.close).toHaveBeenCalledTimes(1);
        expect(env.exit).toHaveBeenCalledTimes(1);
        expect(env.exit).toHaveBeenCalledWith(0);
    });

    it("still exits with code 0 when server.close() rejects (we've already decided to leave)", async () => {
        const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
        const signals = new EventEmitter();
        const exit = vi.fn();
        const log = vi.fn();
        const close = vi.fn().mockRejectedValue(new Error('already torn down'));

        installLifecycleHandlers({ server: { close }, stdin, signals, exit, log });
        signals.emit('SIGTERM');
        await settle();

        expect(close).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('calls server.close() before exit() (cleanup runs before the process is torn down)', async () => {
        const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
        const signals = new EventEmitter();
        const exit = vi.fn();
        const calls: string[] = [];
        const close = vi.fn().mockImplementation(async () => {
            calls.push('close');
        });
        const trackedExit = (code: number) => {
            calls.push(`exit(${code})`);
            exit(code);
        };

        installLifecycleHandlers({ server: { close }, stdin, signals, exit: trackedExit });
        signals.emit('SIGTERM');
        await settle();

        expect(calls).toEqual(['close', 'exit(0)']);
    });
});
