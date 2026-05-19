// End-to-end test: drive get_staging_directory through a real MCP
// Server↔Client transport pair, with the staging volume mounted and not.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMockFreeAgentClient,
  connectTestMcpClient,
  parseToolResult as parseResult,
} from './_setup.js';

describe('get_staging_directory (via MCP)', () => {
  describe('with staging mounted', () => {
    let client: Client;
    let stagingDir: string;

    beforeAll(async () => {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-staging-dir-'));
      client = await connectTestMcpClient(createMockFreeAgentClient(), { stagingSessionPath: stagingDir });
    });

    afterAll(async () => {
      await client.close();
      fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('lists get_staging_directory in tools/list', async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain('get_staging_directory');
    });

    it('no longer exposes the removed stage_evidence tool', async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).not.toContain('stage_evidence');
    });

    it('reports ready:true with the live session path', async () => {
      const result = await client.callTool({ name: 'get_staging_directory', arguments: {} });
      const parsed = parseResult(result) as { ready: boolean; path: string | null };
      expect(parsed.ready).toBe(true);
      expect(parsed.path).toBe(stagingDir);
    });
  });

  describe('with staging not mounted', () => {
    let client: Client;

    beforeEach(async () => {
      // Default opt-out: stagingSessionPath omitted ⇒ ready=false.
      client = await connectTestMcpClient(createMockFreeAgentClient());
    });

    afterEach(async () => { await client.close(); });

    it('reports ready:false with a null path', async () => {
      const result = await client.callTool({ name: 'get_staging_directory', arguments: {} });
      const parsed = parseResult(result) as { ready: boolean; path: string | null };
      expect(parsed.ready).toBe(false);
      expect(parsed.path).toBeNull();
    });
  });
});
