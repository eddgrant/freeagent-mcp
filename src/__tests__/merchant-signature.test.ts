import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { merchantSignature } from '../merchant-signature.js';

describe('merchantSignature — synthetic cases', () => {
    it('returns empty string for empty input', () => {
        expect(merchantSignature('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
        expect(merchantSignature('   ')).toBe('');
    });

    describe('Starling-format descriptions', () => {
        it('extracts display name before "(Method)/..."', () => {
            expect(merchantSignature('TfL (Google Pay)/TFL TRAVEL CH/POS/')).toBe('TFL');
        });

        it('collapses payment-method variants to the same signature', () => {
            const a = merchantSignature('TfL (Google Pay)/TFL TRAVEL CH/POS/');
            const b = merchantSignature('TfL (Contactless)/TFL TRAVEL CH/POS/');
            expect(a).toBe(b);
        });

        it('decodes HTML entities (&amp;)', () => {
            expect(merchantSignature('Marks &amp; Spencer (Google Pay)/M&amp;S SIMPLY FOOD - SSP/POS/'))
                .toBe('MARKS & SPENCER');
        });

        it('preserves punctuation that is part of merchant identity', () => {
            expect(merchantSignature('1&amp;1 Web Hosting (Card Payment)/IONOS CLOUD LTD/POS/')).toBe('1&1 WEB HOSTING');
            expect(merchantSignature('Co-op (Google Pay)/CO OP GROUP FOOD/POS/')).toBe('CO-OP');
        });

        it('collapses whitespace runs', () => {
            expect(merchantSignature('Some  Merchant   Name (Online Payment)/RAW/POS/')).toBe('SOME MERCHANT NAME');
        });

        it('strips trailing punctuation', () => {
            expect(merchantSignature('Foo. (Online Payment)/RAW/POS/')).toBe('FOO');
        });
    });

    describe('non-Starling formats', () => {
        it('falls back to first segment before "/"', () => {
            expect(merchantSignature('PLAIN MERCHANT NAME/RAW/')).toBe('PLAIN MERCHANT NAME');
        });

        it('caps the fallback at 40 chars', () => {
            const long = 'A'.repeat(50);
            const sig = merchantSignature(long);
            expect(sig.length).toBeLessThanOrEqual(40);
        });

        it('uppercases case-mixed input', () => {
            expect(merchantSignature('mixedCase Merchant')).toBe('MIXEDCASE MERCHANT');
        });
    });

    describe('locationStopwords option', () => {
        it('strips trailing location tokens when supplied', () => {
            const sig = merchantSignature(
                'Leon Euston (Google Pay)/Leon Euston/POS/',
                { locationStopwords: ['EUSTON', 'LONDON'] },
            );
            expect(sig).toBe('LEON');
        });

        it('does NOT strip the only remaining token (avoids empty signatures)', () => {
            const sig = merchantSignature(
                'Euston (Google Pay)/EUSTON/POS/',
                { locationStopwords: ['EUSTON'] },
            );
            expect(sig).toBe('EUSTON');
        });

        it('default (no stopwords) preserves location suffixes', () => {
            expect(merchantSignature('Leon Euston (Google Pay)/Leon Euston/POS/')).toBe('LEON EUSTON');
        });
    });
});

describe('merchantSignature — real fixture (anonymised Starling, 12 months)', () => {
    interface Fixture {
        count: number;
        transactions: Array<{
            description: string;
            full_description: string;
            amount: string;
            dated_on: string;
            category_url?: string;
        }>;
    }

    const fixturePath = path.join(__dirname, 'fixtures', 'bank-descriptions.json');
    const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

    it('processes every fixture row without throwing or returning empty', () => {
        for (const tx of fixture.transactions) {
            const sig = merchantSignature(tx.description);
            expect(sig.length).toBeGreaterThan(0);
        }
    });

    it('reduces the corpus to a meaningful number of merchant groups', () => {
        // 104 descriptions → expect strong-but-not-extreme grouping.
        // If we end up with the same number as descriptions, normalisation
        // is doing nothing. If we end up with single-digit groups, we're
        // over-collapsing distinct merchants.
        const groups = new Set<string>();
        for (const tx of fixture.transactions) groups.add(merchantSignature(tx.description));
        expect(groups.size).toBeGreaterThan(20);
        expect(groups.size).toBeLessThan(fixture.transactions.length);
    });

    // Known-equivalent merchant pairs from the real data. These are the
    // canary tests — if any of these fail, the normaliser has regressed
    // on a real-world variation that we know exists.
    const expectedEquivalences: Array<{ name: string; descriptions: string[] }> = [
        {
            name: 'TfL — Google Pay vs Contactless',
            descriptions: [
                'TfL (Google Pay)/TFL TRAVEL CH/POS/',
                'TfL (Contactless)/TFL TRAVEL CH/POS/',
            ],
        },
        {
            name: 'Anthropic — different raw merchant strings',
            descriptions: [
                'Anthropic (Online Payment)/CLAUDE.AI SUBSCRIPTION/POS/',
                'Anthropic (Online Payment)/ANTHROPIC/POS/',
            ],
        },
        {
            name: 'Google Cloud — different product variants',
            descriptions: [
                'Google Cloud (Card Payment)/Google GSUITE_userA/POS/',
                'Google Cloud (Card Payment)/Google Workspace_userA/POS/',
            ],
        },
        {
            name: 'Acme Designs (Tide) — Faster Payments In/Out',
            descriptions: [
                'Acme Designs Limited (Tide) (Faster Payments In)/TIS Funds Withdraw/PAYMENT/',
                'Acme Designs Limited (Tide) (Faster Payments Out)/Savings/PAYMENT/',
            ],
        },
        {
            name: 'Eeukltd Ca — recurring batch numbers',
            descriptions: [
                'Eeukltd Ca (Direct Credit)/EEUK BATCH 1402/DIRECTDEP/',
                'Eeukltd Ca (Direct Credit)/EEUK BATCH 1490/DIRECTDEP/',
            ],
        },
    ];

    for (const eq of expectedEquivalences) {
        it(`groups equivalents: ${eq.name}`, () => {
            const sigs = eq.descriptions.map(d => merchantSignature(d));
            const unique = new Set(sigs);
            expect(unique.size).toBe(1);
            // Sanity: signature is non-empty.
            expect(sigs[0].length).toBeGreaterThan(0);
        });
    }

    // Distinctness — different merchants must NOT collapse.
    const expectedDistinctions: Array<{ name: string; descriptions: string[] }> = [
        {
            name: 'TfL vs Sainsbury\'s',
            descriptions: [
                'TfL (Google Pay)/TFL TRAVEL CH/POS/',
                "Sainsbury's (Google Pay)/SAINSBURYS S/MKTS/POS/",
            ],
        },
        {
            name: 'Anthropic vs Google Cloud',
            descriptions: [
                'Anthropic (Online Payment)/ANTHROPIC/POS/',
                'Google Cloud (Card Payment)/Google GSUITE_userA/POS/',
            ],
        },
        {
            name: 'Different L&G policy lines (intentionally different merchants from the user\'s POV)',
            descriptions: [
                'Aegon Sipp (Direct Debit)/REFNUM PERSON_A/DIRECTDEBIT/',
                'Hiscox  (Direct Debit)/REFNUM/DIRECTDEBIT/',
            ],
        },
    ];

    for (const d of expectedDistinctions) {
        it(`keeps distinct: ${d.name}`, () => {
            const sigs = d.descriptions.map(s => merchantSignature(s));
            const unique = new Set(sigs);
            expect(unique.size).toBe(d.descriptions.length);
        });
    }
});
