import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    DEFAULT_PAGINATION_CONCURRENCY,
    MAX_PAGINATION_CONCURRENCY,
    mapWithConcurrency,
    parseLastPage,
    parseRetryAfter,
    readPaginationConcurrency,
} from '../pagination.js';

describe('parseLastPage', () => {
    it('parses FreeAgent-style single-quoted rel=last', () => {
        const link = `<https://api.freeagent.com/v2/timeslips?page=708&per_page=100>; rel='last', <https://api.freeagent.com/v2/timeslips?page=2&per_page=100>; rel='next'`;
        expect(parseLastPage(link)).toBe(708);
    });

    it('parses RFC 5988 double-quoted rel="last"', () => {
        const link = `<https://api.freeagent.com/v2/projects?page=10&per_page=100>; rel="last"`;
        expect(parseLastPage(link)).toBe(10);
    });

    it('returns null when the header is absent', () => {
        expect(parseLastPage(undefined)).toBeNull();
        expect(parseLastPage(null)).toBeNull();
        expect(parseLastPage('')).toBeNull();
    });

    it('returns null when there is no rel=last segment', () => {
        expect(parseLastPage(`<https://api.freeagent.com/v2/x?page=2>; rel='next'`)).toBeNull();
    });

    it('returns null when rel=last has no numeric page param', () => {
        expect(parseLastPage(`<https://api.freeagent.com/v2/x?per_page=100>; rel='last'`)).toBeNull();
        expect(parseLastPage(`<https://api.freeagent.com/v2/x?page=abc>; rel='last'`)).toBeNull();
    });

    it('handles array-form headers (Node sometimes presents headers as arrays)', () => {
        expect(parseLastPage([`<https://api.freeagent.com/v2/x?page=5>; rel='last'`])).toBe(5);
    });
});

describe('parseRetryAfter', () => {
    it('parses delta-seconds (numeric) into milliseconds', () => {
        expect(parseRetryAfter('5')).toBe(5000);
        expect(parseRetryAfter('0')).toBe(0);
    });

    it('parses HTTP-date into a delay relative to now', () => {
        const future = new Date(Date.now() + 10_000).toUTCString();
        const ms = parseRetryAfter(future);
        expect(ms).not.toBeNull();
        // Allow a small clock-skew window.
        expect(ms!).toBeGreaterThanOrEqual(8_000);
        expect(ms!).toBeLessThanOrEqual(11_000);
    });

    it('returns null on missing or unparseable input', () => {
        expect(parseRetryAfter(undefined)).toBeNull();
        expect(parseRetryAfter('')).toBeNull();
        expect(parseRetryAfter('not-a-date-or-number')).toBeNull();
    });

    it('handles array-form headers', () => {
        expect(parseRetryAfter(['7'])).toBe(7000);
    });
});

describe('mapWithConcurrency', () => {
    it('preserves input order regardless of completion order', async () => {
        const delays = [50, 5, 30, 10, 20];
        const result = await mapWithConcurrency(delays, 3, async (ms, i) => {
            await new Promise(r => setTimeout(r, ms));
            return i;
        });
        expect(result).toEqual([0, 1, 2, 3, 4]);
    });

    it('respects the concurrency cap (max in-flight never exceeds it)', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({ length: 12 }, (_, i) => i);
        await mapWithConcurrency(items, 3, async (i) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return i;
        });
        expect(maxInFlight).toBe(3);
    });

    it('returns immediately for an empty input', async () => {
        const fn = vi.fn();
        const result = await mapWithConcurrency([], 4, fn);
        expect(result).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });

    it('clamps the cap to the number of items when there are fewer items than the cap', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await mapWithConcurrency([1, 2], 8, async (n) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return n;
        });
        expect(maxInFlight).toBe(2);
    });

    it('propagates rejections from the worker function', async () => {
        await expect(
            mapWithConcurrency([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error('boom');
                return n;
            }),
        ).rejects.toThrow('boom');
    });
});

describe('readPaginationConcurrency', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
    });

    it('returns the default when the env var is unset', () => {
        expect(readPaginationConcurrency({})).toBe(DEFAULT_PAGINATION_CONCURRENCY);
    });

    it('returns a valid override', () => {
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: '8' })).toBe(8);
    });

    it('clamps values above the maximum', () => {
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: '64' })).toBe(MAX_PAGINATION_CONCURRENCY);
        expect(warn).toHaveBeenCalled();
    });

    it('falls back to the default for non-numeric values', () => {
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: 'eight' })).toBe(DEFAULT_PAGINATION_CONCURRENCY);
        expect(warn).toHaveBeenCalled();
    });

    it('falls back to the default for zero or negative values', () => {
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: '0' })).toBe(DEFAULT_PAGINATION_CONCURRENCY);
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: '-3' })).toBe(DEFAULT_PAGINATION_CONCURRENCY);
    });

    it('falls back to the default for non-integer values', () => {
        expect(readPaginationConcurrency({ FREEAGENT_PAGINATION_CONCURRENCY: '4.5' })).toBe(DEFAULT_PAGINATION_CONCURRENCY);
    });
});
