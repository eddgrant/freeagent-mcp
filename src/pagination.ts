// Pagination plumbing for FreeAgentClient. Pure helpers live here so they
// can be unit-tested in isolation; the client wires them into actual
// HTTP calls.

export const DEFAULT_PAGINATION_CONCURRENCY = 4;
export const MAX_PAGINATION_CONCURRENCY = 16;

// Read a per-process override from FREEAGENT_PAGINATION_CONCURRENCY.
// Invalid values fall back to the default with a warning rather than
// throwing — this is a tuning knob, not a hard requirement.
export function readPaginationConcurrency(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.FREEAGENT_PAGINATION_CONCURRENCY;
    if (!raw) return DEFAULT_PAGINATION_CONCURRENCY;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        console.error(`[Config] Invalid FREEAGENT_PAGINATION_CONCURRENCY="${raw}", using default ${DEFAULT_PAGINATION_CONCURRENCY}`);
        return DEFAULT_PAGINATION_CONCURRENCY;
    }
    if (n > MAX_PAGINATION_CONCURRENCY) {
        console.error(`[Config] FREEAGENT_PAGINATION_CONCURRENCY=${n} clamped to ${MAX_PAGINATION_CONCURRENCY}`);
        return MAX_PAGINATION_CONCURRENCY;
    }
    return n;
}

// Extract the page number from the rel='last' link in a Link header.
// FreeAgent uses single quotes around rel values; standards-compliant
// servers use double quotes. Accept either. Returns null if the header
// is missing, malformed, or doesn't contain a valid page= segment.
export function parseLastPage(linkHeader: string | string[] | undefined | null): number | null {
    if (!linkHeader) return null;
    const value = Array.isArray(linkHeader) ? linkHeader.join(', ') : linkHeader;
    const m = value.match(/<([^>]+)>;\s*rel=['"]last['"]/);
    if (!m) return null;
    const pageMatch = m[1].match(/[?&]page=(\d+)(?:&|$)/);
    if (!pageMatch) return null;
    const n = Number(pageMatch[1]);
    return Number.isInteger(n) && n >= 1 ? n : null;
}

// Parse a Retry-After header, returning a delay in milliseconds.
// Supports both "delta-seconds" (numeric, by far the most common) and
// HTTP-date (rare, included for completeness). Returns null when the
// header is absent or unparseable.
export function parseRetryAfter(header: string | string[] | undefined | null): number | null {
    if (!header) return null;
    const value = Array.isArray(header) ? header[0] : header;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return null;
}

// Run async tasks over `items` with bounded concurrency. Results are
// returned in the original index order regardless of completion order.
// Any rejection short-circuits via Promise.all and propagates upward.
export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];
    const cap = Math.max(1, Math.min(concurrency, items.length));
    const results: R[] = new Array(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: cap }, () => worker()));
    return results;
}
