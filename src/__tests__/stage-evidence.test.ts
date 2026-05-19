import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stageEvidence, MAX_BYTES, ALLOWED_CONTENT_TYPES } from '../stage-evidence.js';

// Helpers: build minimal byte sequences whose magic bytes match the
// claimed content type. We use small deterministic payloads so test
// assertions can compare bytes-on-disk exactly.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_MAGIC  = Buffer.from('GIF89a', 'ascii');
const PDF_MAGIC  = Buffer.from('%PDF-', 'ascii');

const fixture = (magic: Buffer, payload = 'test-content') =>
    Buffer.concat([magic, Buffer.from(payload, 'utf8')]).toString('base64');

const FIXED_SUFFIX = '0123456789ab';
const fixedSuffix = () => FIXED_SUFFIX;

describe('stageEvidence', () => {
    let sessionPath: string;

    beforeEach(() => {
        sessionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-evidence-test-'));
    });

    afterEach(() => {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    });

    describe('staging readiness', () => {
        it('refuses with staging_volume_not_mounted when sessionPath is null', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath: null },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe('staging_volume_not_mounted');
        });
    });

    describe('happy path', () => {
        it.each([
            ['application/pdf' as const, PDF_MAGIC,  'receipt.pdf'],
            ['image/jpeg'      as const, JPEG_MAGIC, 'receipt.jpg'],
            ['image/png'       as const, PNG_MAGIC,  'receipt.png'],
            ['image/gif'       as const, GIF_MAGIC,  'receipt.gif'],
        ])('stages a valid %s file', (contentType, magic, fileName) => {
            const data = fixture(magic);
            const result = stageEvidence(
                { data, file_name: fileName, content_type: contentType },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.result.content_type).toBe(contentType);
            expect(result.result.evidence_path).toBe(
                path.join(sessionPath, `${FIXED_SUFFIX}-${fileName}`),
            );
            expect(fs.existsSync(result.result.evidence_path)).toBe(true);
            expect(fs.readFileSync(result.result.evidence_path)).toEqual(
                Buffer.from(data, 'base64'),
            );
            expect(result.result.bytes_written).toBe(Buffer.from(data, 'base64').length);
        });

        it('uses random suffix by default to avoid collisions', () => {
            const data = fixture(PDF_MAGIC);
            const a = stageEvidence({ data, file_name: 'r.pdf', content_type: 'application/pdf' }, { sessionPath });
            const b = stageEvidence({ data, file_name: 'r.pdf', content_type: 'application/pdf' }, { sessionPath });
            expect(a.ok && b.ok).toBe(true);
            if (a.ok && b.ok) {
                expect(a.result.evidence_path).not.toBe(b.result.evidence_path);
                expect(fs.existsSync(a.result.evidence_path)).toBe(true);
                expect(fs.existsSync(b.result.evidence_path)).toBe(true);
            }
        });

        it('writes the file with mode 0600', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            if (!result.ok) throw new Error('expected success');
            const stat = fs.statSync(result.result.evidence_path);
            // Mask off everything except the permission bits.
            expect(stat.mode & 0o777).toBe(0o600);
        });

        it('does not leave a .tmp file behind on success', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            if (!result.ok) throw new Error('expected success');
            const entries = fs.readdirSync(sessionPath);
            expect(entries.some(e => e.endsWith('.tmp'))).toBe(false);
        });
    });

    describe('content_type validation', () => {
        it('refuses unsupported content types', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r.txt', content_type: 'text/plain' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'unsupported_content_type') {
                expect(result.error.provided).toBe('text/plain');
                expect(result.error.allowed).toEqual(ALLOWED_CONTENT_TYPES);
            } else {
                throw new Error('expected unsupported_content_type');
            }
        });
    });

    describe('base64 validation', () => {
        it('refuses invalid base64', () => {
            const result = stageEvidence(
                { data: 'not!base64!@#$', file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe('invalid_base64');
        });

        it('refuses base64 with bad length', () => {
            // 5 chars is not a multiple of 4 and won't decode properly.
            const result = stageEvidence(
                { data: 'abcde', file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe('invalid_base64');
        });

        it('accepts base64 with whitespace and standard padding', () => {
            // Buffer.from cleans whitespace, but we want to confirm we don't
            // reject legitimate input that includes line breaks.
            const padded = fixture(PDF_MAGIC).match(/.{1,40}/g)!.join('\n');
            const result = stageEvidence(
                { data: padded, file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(true);
        });

        it('refuses empty data', () => {
            const result = stageEvidence(
                { data: '', file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe('invalid_base64');
        });
    });

    describe('size limit', () => {
        it('refuses files larger than MAX_BYTES', () => {
            // Build a buffer 1 byte over the limit. Magic bytes upfront so
            // we don't get tripped up by the magic-byte check first.
            const oversize = Buffer.concat([
                PDF_MAGIC,
                Buffer.alloc(MAX_BYTES + 1 - PDF_MAGIC.length, 0x20),
            ]);
            const result = stageEvidence(
                { data: oversize.toString('base64'), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'too_large') {
                expect(result.error.bytes).toBe(MAX_BYTES + 1);
                expect(result.error.max).toBe(MAX_BYTES);
            } else {
                throw new Error('expected too_large');
            }
        });
    });

    describe('magic-byte verification', () => {
        it('refuses when claimed type and detected type differ', () => {
            // Claim PDF but actually send PNG bytes.
            const result = stageEvidence(
                { data: fixture(PNG_MAGIC), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'magic_byte_mismatch') {
                expect(result.error.claimed).toBe('application/pdf');
                expect(result.error.detected).toBe('image/png');
            } else {
                throw new Error('expected magic_byte_mismatch');
            }
        });

        it('refuses unrecognised magic bytes', () => {
            const result = stageEvidence(
                { data: Buffer.from('hello world').toString('base64'), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'magic_byte_mismatch') {
                expect(result.error.detected).toBeUndefined();
            } else {
                throw new Error('expected magic_byte_mismatch');
            }
        });
    });

    describe('filename sanitisation', () => {
        it('rejects empty filenames', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: '', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'invalid_file_name') {
                expect(result.error.reason).toBe('empty');
            } else {
                throw new Error('expected invalid_file_name(empty)');
            }
        });

        it('rejects filenames containing null bytes', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r\0.pdf', content_type: 'application/pdf' },
                { sessionPath },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'invalid_file_name') {
                expect(result.error.reason).toBe('null_byte');
            } else {
                throw new Error('expected invalid_file_name(null_byte)');
            }
        });

        it('rejects "." and ".."', () => {
            for (const name of ['.', '..']) {
                const result = stageEvidence(
                    { data: fixture(PDF_MAGIC), file_name: name, content_type: 'application/pdf' },
                    { sessionPath },
                );
                expect(result.ok).toBe(false);
                if (!result.ok && result.error.code === 'invalid_file_name') {
                    expect(result.error.reason).toBe('reserved');
                } else {
                    throw new Error(`expected reserved for ${name}`);
                }
            }
        });

        it('rejects filenames where every char gets stripped', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: '!!!@@@###', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            expect(result.ok).toBe(false);
            if (!result.ok && result.error.code === 'invalid_file_name') {
                expect(result.error.reason).toBe('all_chars_stripped');
            } else {
                throw new Error('expected all_chars_stripped');
            }
        });

        it('strips path components — no traversal', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: '../../etc/passwd', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            // basename of "../../etc/passwd" is "passwd"; allowlist preserves it.
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.result.evidence_path).toBe(path.join(sessionPath, `${FIXED_SUFFIX}-passwd`));
                // Confirm the file lives inside sessionPath, not somewhere else.
                expect(path.dirname(result.result.evidence_path)).toBe(sessionPath);
            }
        });

        it('replaces disallowed characters with underscore', () => {
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'my receipt (£42).pdf', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            expect(result.ok).toBe(true);
            if (result.ok) {
                // Spaces, parens, and £ are stripped; underscores collapsed.
                expect(result.result.evidence_path).toBe(
                    path.join(sessionPath, `${FIXED_SUFFIX}-my_receipt_42_.pdf`),
                );
            }
        });

        it('truncates filenames longer than 64 characters', () => {
            const longBase = 'a'.repeat(80) + '.pdf';
            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: longBase, content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            expect(result.ok).toBe(true);
            if (result.ok) {
                const written = path.basename(result.result.evidence_path);
                // 12-char suffix + '-' + ≤64 sanitised = ≤77 total
                expect(written.length).toBeLessThanOrEqual(77);
                expect(written.startsWith(`${FIXED_SUFFIX}-`)).toBe(true);
            }
        });
    });

    describe('write failure handling', () => {
        it('returns write_failed when the staging dir is gone', () => {
            // Delete the staging dir between setup and call.
            fs.rmSync(sessionPath, { recursive: true, force: true });

            const result = stageEvidence(
                { data: fixture(PDF_MAGIC), file_name: 'r.pdf', content_type: 'application/pdf' },
                { sessionPath, randomSuffix: fixedSuffix },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe('write_failed');

            // Recreate so afterEach doesn't fail.
            fs.mkdirSync(sessionPath, { recursive: true });
        });
    });
});
