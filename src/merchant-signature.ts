// Merchant signature normalisation.
//
// Bank-transaction descriptions are noisy: the same merchant appears in
// many variants ("TfL (Google Pay)/TFL TRAVEL CH/POS/", "TfL (Contactless)
// /TFL TRAVEL CH/POS/", and so on). The history-aware proposal logic
// groups transactions by a "merchant signature" so it can find prior
// reconciliations on the same merchant. Signatures must be:
//
//  - STABLE: the same merchant in different variants must collapse to the
//    same signature, otherwise we miss a category match.
//  - DISTINCT: different merchants must NOT collapse to the same
//    signature, otherwise we propose the wrong category.
//
// Stability is the silent-failure risk and is exercised heavily against
// the real-world fixture in src/__tests__/fixtures/bank-descriptions.json.
//
// v1 strategy is regex-based and deliberately simple. Fuzzy grouping
// (Jaccard, edit distance, abbreviation maps for things like
// "MARKS & SPENCER" ↔ "M&S") is a v1.x follow-up.

const HTML_ENTITIES: Array<[RegExp, string]> = [
    [/&amp;/g, '&'],
    [/&lt;/g, '<'],
    [/&gt;/g, '>'],
    [/&quot;/g, '"'],
    [/&apos;/g, "'"],
    [/&#39;/g, "'"],
];

// Starling-style description: "<DisplayName> (<Method>)/<rawFeed>/<type>/"
// where <Method> is the payment-method tag the bank prepends.
const STARLING_DISPLAY_PATTERN = /^(.+?)\s*\([^)]+\)\s*\//;

export interface SignatureOptions {
    /** Strip these tokens from the trailing end of the canonical signature
     *  before returning. Useful for stripping merchant locations like
     *  "LONDON" or "EUSTON" so "LEON EUSTON" collapses with "LEON" — but
     *  also dangerous (location stripping can over-merge). v1 leaves this
     *  empty by default. */
    locationStopwords?: readonly string[];
}

export function merchantSignature(description: string, opts: SignatureOptions = {}): string {
    if (typeof description !== 'string' || description.length === 0) return '';

    let working = description;
    for (const [pat, rep] of HTML_ENTITIES) working = working.replace(pat, rep);

    // Path 1 — Starling-style: take the display name before "(<Method>)/".
    const starlingMatch = working.match(STARLING_DISPLAY_PATTERN);
    let candidate: string;
    if (starlingMatch) {
        candidate = starlingMatch[1];
    } else {
        // Path 2 — fall back to first segment before "/" (other feed
        // formats), or the first 40 chars if there's no slash.
        candidate = working.split('/')[0].slice(0, 40);
    }

    return canonicalise(candidate, opts.locationStopwords ?? []);
}

function canonicalise(s: string, locationStopwords: readonly string[]): string {
    const trimmed = s.trim();
    if (trimmed.length === 0) return '';

    // Uppercase + collapse internal whitespace runs to single spaces.
    let canon = trimmed.toUpperCase().replace(/\s+/g, ' ');

    // Strip leading/trailing punctuation but preserve internal punctuation
    // that's part of merchant identity (M&S, 1&1, Co-op, .com, etc.).
    canon = canon.replace(/^[^A-Z0-9&]+/, '').replace(/[^A-Z0-9&)]+$/, '');

    if (locationStopwords.length > 0) {
        const tokens = canon.split(' ');
        while (
            tokens.length > 1 &&
            locationStopwords.includes(tokens[tokens.length - 1])
        ) {
            tokens.pop();
        }
        canon = tokens.join(' ');
    }

    return canon;
}
