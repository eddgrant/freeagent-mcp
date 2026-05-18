#!/usr/bin/env node
// One-shot tool that built src/__tests__/fixtures/bank-descriptions.json
// from a tool-result dump of mcp__freeagent__list_bank_transactions.
// Kept here so anyone can regenerate or tweak the fixture later, but it
// is not part of normal build/test flows.
//
// Usage: node scripts/anonymise-bank-descriptions.mjs <input-json> <output-json>
//
// The input is the raw output file from the FreeAgent MCP (a JSON array
// shaped like [{ type: "text", text: "<json string of transactions>" }]).
// The output is a JSON array of { description, full_description, amount,
// dated_on, category_url? } where every occurrence of personally-
// identifying tokens has been rewritten — preserving the structural
// noise (slashes, suffix tags, capitalisation chaos) that the merchant
// signature normaliser actually has to deal with.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
    console.error('usage: node anonymise-bank-descriptions.mjs <input> <output>');
    process.exit(2);
}

const wrapped = JSON.parse(readFileSync(inputPath, 'utf8'));
const transactions = JSON.parse(wrapped[0].text);

// PII rewrites. Order matters — most-specific first, generic regexes last.
const literalRewrites = [
    // Personal names (case sensitive — preserve "EG", "NL", "E GRANT", etc.)
    [/Edd Grant Designs Limited/g, 'Acme Designs Limited'],
    [/Edd Grant Designs/g, 'Acme Designs'],
    [/Edd Grant Monzo Account/g, 'Person A Monzo Account'],
    [/Edd Grant/g, 'Person A'],
    [/Natasha Larke/g, 'Person B'],
    [/\bE GRANT\b/g, 'P A'],
    [/\bN LARKE\b/g, 'P B'],
    [/\bEG Salary\b/g, 'PA Salary'],
    [/\bNL Salary\b/g, 'PB Salary'],
    [/\bEG Div\b/g, 'PA Div'],
    [/\bNL Div\b/g, 'PB Div'],
    [/\bEG Dividend\b/g, 'PA Dividend'],
    [/\bNL Dividend\b/g, 'PB Dividend'],
    [/\bEG Expenses\b/g, 'PA Expenses'],
    [/\bEGD\b/g, 'AD'],   // company initialism: Edd Grant Designs → Acme Designs
    [/eddgrant/g, 'userA'],   // no \b — underscore is a word char and breaks \b matches
    [/eddgr(?![a-z])/g, 'userA'],
];
const regexRewrites = [
    // Long digit strings (account/customer/HMRC reference numbers).
    // Insurance refs like 0251471710, 1830471, 4RCKP88, 106981211.
    [/\b\d{6,}\b/g, 'REFNUM'],
    [/\b[A-Z0-9]{6,}\b/g, (m) => (/^\d/.test(m) ? 'REFNUM' : m)],
    // Mixed-case reference patterns: "Dee1000312", "DEE1005294", "ZC100586".
    [/\b[A-Za-z]{1,4}\d{4,}\b/g, 'REFNUM'],
    // Sort codes (occasional safety net — none observed in this dataset
    // but bank-feed fields can include them).
    [/\b\d{2}-\d{2}-\d{2}\b/g, 'XX-XX-XX'],
    // IBANs (also a safety net).
    [/\bGB\d{2}[A-Z]{4}\d{14}\b/g, 'IBAN'],
];

// Fallback name pass — runs AFTER digit/alphanumeric replacement so it
// catches names left bare by reference-number stripping (e.g. the
// "GRANT" in "73869E GRANT" → "REFNUM GRANT" after the REF pass).
const fallbackNameRewrites = [
    [/\bGRANT\b/g, 'PERSON_A'],
    [/\bLARKE\b/g, 'PERSON_B'],
];

function anonymise(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const [pat, rep] of literalRewrites) out = out.replace(pat, rep);
    for (const [pat, rep] of regexRewrites) out = out.replace(pat, rep);
    for (const [pat, rep] of fallbackNameRewrites) out = out.replace(pat, rep);
    return out;
}

const seen = new Set();
const corpus = [];
for (const tx of transactions) {
    const desc = anonymise(tx.description ?? '');
    if (!desc || seen.has(desc)) continue;
    seen.add(desc);
    corpus.push({
        description: desc,
        full_description: anonymise(tx.full_description ?? ''),
        amount: tx.amount,
        dated_on: tx.dated_on,
        category_url: tx.bank_transaction_explanations?.[0]?.category,
    });
}

corpus.sort((a, b) => a.description.localeCompare(b.description));

writeFileSync(
    outputPath,
    JSON.stringify(
        {
            generated_at: new Date().toISOString().slice(0, 10),
            source: 'Starling business account, last 12 months',
            anonymised: true,
            count: corpus.length,
            note: 'See scripts/anonymise-bank-descriptions.mjs for the rewrite rules. Personal names and account/customer reference numbers are replaced; merchant names and structural noise are preserved verbatim.',
            transactions: corpus,
        },
        null,
        2,
    ),
);
console.error(`wrote ${corpus.length} unique anonymised descriptions to ${outputPath}`);
