// Lifecycle handlers for the MCP server. Extracted into a small function
// taking its dependencies as arguments so it can be exercised in unit
// tests without polluting the real Node process.
//
// Background: the MCP SDK's StdioServerTransport only listens for stdin
// 'data' and 'error' events — not 'end' or 'close'. So if these handlers
// were not installed, an MCP client (Claude Code, etc.) disconnecting
// would leave the Node process running forever, and the surrounding
// container would never exit.

import type { EventEmitter } from 'node:events';

export interface Closable {
    close(): Promise<void>;
}

export interface LifecycleDeps {
    server: Closable;
    /** Source of stdin 'end' / 'close' events. Defaults to process.stdin. */
    stdin?: NodeJS.ReadableStream;
    /** Source of process signals. Defaults to process. */
    signals?: NodeJS.EventEmitter | EventEmitter;
    /** Terminator. Defaults to process.exit. Tests inject a stub. */
    exit?: (code: number) => void;
    /** Logger. Defaults to console.error. */
    log?: (message: string) => void;
}

export function installLifecycleHandlers(deps: LifecycleDeps): void {
    const stdin = deps.stdin ?? process.stdin;
    const signals = deps.signals ?? process;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const log = deps.log ?? ((message: string) => console.error(message));

    let shuttingDown = false;
    const shutdown = async (reason: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`[Setup] Shutting down: ${reason}`);
        try { await deps.server.close(); } catch { /* already closed */ }
        exit(0);
    };

    signals.on('SIGINT', () => { void shutdown('SIGINT'); });
    signals.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    stdin.on('end', () => { void shutdown('stdin EOF'); });
    stdin.on('close', () => { void shutdown('stdin closed'); });
}
