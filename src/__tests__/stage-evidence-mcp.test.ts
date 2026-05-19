// End-to-end test: drive stage_evidence through a real MCP Server↔Client
// transport pair. Verifies the tool definition shape, argument plumbing,
// and that the structured ok/error JSON is what the agent will see.

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

const PDF_HEADER = Buffer.from('%PDF-', 'ascii');
const pdfBase64 = (payload = 'test') =>
  Buffer.concat([PDF_HEADER, Buffer.from(payload, 'utf8')]).toString('base64');

describe('stage_evidence (via MCP)', () => {
  describe('with staging mounted', () => {
    let client: Client;
    let stagingDir: string;

    beforeAll(async () => {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-evidence-mcp-'));
      const mockFaClient = createMockFreeAgentClient();
      client = await connectTestMcpClient(mockFaClient, { stagingSessionPath: stagingDir });
    });

    afterAll(async () => {
      await client.close();
      fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('lists stage_evidence in tools/list', async () => {
      const result = await client.listTools();
      const names = result.tools.map(t => t.name);
      expect(names).toContain('stage_evidence');
    });

    it('writes a valid PDF and returns ok=true with the path', async () => {
      const result = await client.callTool({
        name: 'stage_evidence',
        arguments: { data: pdfBase64('hello'), file_name: 'receipt.pdf', content_type: 'application/pdf' },
      });
      const parsed = parseResult(result) as { ok: boolean; evidence_path?: string; bytes_written?: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.evidence_path).toBeTruthy();
      expect(path.dirname(parsed.evidence_path!)).toBe(stagingDir);
      expect(fs.existsSync(parsed.evidence_path!)).toBe(true);
    });

    it('returns ok=false structured error for content-type mismatch', async () => {
      const result = await client.callTool({
        name: 'stage_evidence',
        arguments: { data: pdfBase64(), file_name: 'r.png', content_type: 'image/png' },
      });
      const parsed = parseResult(result) as { ok: boolean; error?: { code: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe('magic_byte_mismatch');
    });
  });

  describe('with staging not mounted', () => {
    let client: Client;

    beforeEach(async () => {
      const mockFaClient = createMockFreeAgentClient();
      // Default opt-out: stagingSessionPath omitted ⇒ ready=false.
      client = await connectTestMcpClient(mockFaClient);
    });

    afterEach(async () => { await client.close(); });

    it('returns ok=false with staging_volume_not_mounted', async () => {
      const result = await client.callTool({
        name: 'stage_evidence',
        arguments: { data: pdfBase64(), file_name: 'r.pdf', content_type: 'application/pdf' },
      });
      const parsed = parseResult(result) as { ok: boolean; error?: { code: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe('staging_volume_not_mounted');
    });

    it('does not raise an MCP transport error for business-logic failures', async () => {
      // The point: structured failure stays inside a successful tool call,
      // so the agent receives the error code rather than an MCP exception.
      const result = await client.callTool({
        name: 'stage_evidence',
        arguments: { data: pdfBase64(), file_name: 'r.pdf', content_type: 'application/pdf' },
      });
      // No `isError: true` for business-logic failures.
      expect((result as { isError?: boolean }).isError).not.toBe(true);
    });
  });
});
