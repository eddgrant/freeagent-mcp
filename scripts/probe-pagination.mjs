#!/usr/bin/env node
// Read-only probe: verify FreeAgent's pagination contract on every list
// endpoint we hit. Hits each endpoint with `per_page=1` and reports:
//
//   - HTTP status
//   - Link header (presence + rel="next" / rel="last" if any)
//   - The collection key in the response and the number of items
//   - For /categories — the grouped structure (it returns multiple buckets,
//     not a single collection, so its pagination story may differ)
//
// We use per_page=1 so that ANY endpoint with non-trivial data forces
// pagination, making the contract obvious. NOTHING is created, updated,
// or deleted.
//
// Usage:
//   FREEAGENT_CLIENT_ID=... FREEAGENT_CLIENT_SECRET=... \
//   FREEAGENT_ACCESS_TOKEN=... FREEAGENT_REFRESH_TOKEN=... \
//   node scripts/probe-pagination.mjs

const API_BASE = 'https://api.freeagent.com/v2';

const env = {
    clientId: process.env.FREEAGENT_CLIENT_ID,
    clientSecret: process.env.FREEAGENT_CLIENT_SECRET,
    accessToken: process.env.FREEAGENT_ACCESS_TOKEN,
    refreshToken: process.env.FREEAGENT_REFRESH_TOKEN,
};
requireEnv();

// Each entry: [path, expected response key, optional extra params].
// `bank_transactions` and `bank_transaction_explanations` need a
// bank_account URL — resolved at runtime from /bank_accounts.
const FIXED_ENDPOINTS = [
    ['/timeslips', 'timeslips'],
    ['/projects', 'projects'],
    ['/tasks', 'tasks'],
    ['/users', 'users'],
    ['/invoices', 'invoices'],
    ['/bills', 'bills'],
    ['/bank_accounts', 'bank_accounts'],
    // /categories is special — multiple grouped keys, not a single collection.
    ['/categories', '__multi__'],
];

const results = [];

for (const [path, key] of FIXED_ENDPOINTS) {
    results.push(await probe(path, key));
}

// /bank_transactions* require a bank_account param. Pick the first one we can find.
const bankAccountUrl = await firstBankAccountUrl();
if (bankAccountUrl) {
    results.push(await probe(`/bank_transactions?bank_account=${encodeURIComponent(bankAccountUrl)}`, 'bank_transactions'));
    results.push(await probe(`/bank_transaction_explanations?bank_account=${encodeURIComponent(bankAccountUrl)}`, 'bank_transaction_explanations'));
} else {
    console.log('(skipping /bank_transactions* — no bank account available)');
}

// Render a markdown-ish summary at the end for easy pasting.
console.log();
console.log('=== Pagination probe summary ===');
console.log();
console.log('| endpoint | status | items | Link present | rel="next" present | shape |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
    console.log(`| \`${r.path}\` | ${r.status} | ${r.itemCount ?? 'n/a'} | ${r.hasLink ? 'yes' : 'no'} | ${r.hasNext ? 'yes' : 'no'} | ${r.shapeNote} |`);
}
console.log();
console.log('Raw Link headers (first 200 chars each):');
for (const r of results) {
    if (r.linkHeader) console.log(`  ${r.path}\n    ${r.linkHeader.slice(0, 200)}`);
}
console.log();
console.log('Verdict per endpoint:');
for (const r of results) {
    console.log(`  ${r.path}: ${r.verdict}`);
}

// ---------------------------------------------------------------------------

async function probe(path, key) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API_BASE}${path}${sep}per_page=1`;
    console.log(`Probing ${path} ...`);
    const { res, body } = await rawApi('GET', url);

    const linkHeader = res.headers.get('link') || '';
    const hasLink = linkHeader.length > 0;
    // FreeAgent uses single quotes around rel values (rel='next'), not the
    // RFC 5988 canonical double quotes — accept either.
    const hasNext = /rel=['"]next['"]/.test(linkHeader);

    let itemCount = null;
    let shapeNote = 'unknown';
    if (key === '__multi__') {
        // /categories: grouped buckets. Report sizes per bucket.
        const buckets = Object.entries(body || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 'non-array'}`);
        shapeNote = `grouped: ${buckets.join(', ')}`;
        itemCount = Object.values(body || {})
            .filter(v => Array.isArray(v))
            .reduce((acc, v) => acc + v.length, 0);
    } else {
        const items = body?.[key];
        if (Array.isArray(items)) {
            itemCount = items.length;
            shapeNote = `flat: ${key}[]`;
        } else if (body && typeof body === 'object') {
            const keys = Object.keys(body);
            shapeNote = `unexpected; keys=${keys.join(',')}`;
        }
    }

    let verdict;
    if (res.status !== 200) {
        verdict = `HTTP ${res.status} — see body above`;
    } else if (key === '__multi__') {
        if (hasLink || hasNext) {
            verdict = 'PAGINATES (Link header present even though shape is grouped)';
        } else {
            verdict = 'LIKELY DOES NOT PAGINATE (grouped response, no Link header at per_page=1)';
        }
    } else if (hasNext) {
        verdict = 'PAGINATES (Link rel="next" present at per_page=1)';
    } else if (hasLink) {
        verdict = 'PAGINATES (Link header present, rel="next" absent — likely on last page)';
    } else if (itemCount === 1) {
        verdict = 'AMBIGUOUS — got 1 item but no Link header. Could be small dataset OR no pagination.';
    } else if (itemCount === 0) {
        verdict = 'EMPTY — endpoint accessible but no data. Re-run when data exists to be conclusive.';
    } else {
        verdict = `UNEXPECTED — ${itemCount} items returned despite per_page=1`;
    }

    return { path, status: res.status, itemCount, hasLink, hasNext, linkHeader, shapeNote, verdict };
}

async function firstBankAccountUrl() {
    const { body } = await rawApi('GET', `${API_BASE}/bank_accounts?per_page=1`);
    return body?.bank_accounts?.[0]?.url || null;
}

async function rawApi(method, url, { retried = false } = {}) {
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${env.accessToken}`,
            Accept: 'application/json',
        },
    });
    if (res.status === 401 && !retried) {
        await refresh();
        return rawApi(method, url, { retried: true });
    }
    const text = await res.text();
    let body = null;
    if (text) {
        try { body = JSON.parse(text); }
        catch { body = text; }
    }
    return { res, body };
}

async function refresh() {
    console.error('  (refreshing access token)');
    const res = await fetch(`${API_BASE}/token_endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: env.refreshToken,
            client_id: env.clientId,
            client_secret: env.clientSecret,
        }),
    });
    if (!res.ok) {
        console.error('Token refresh failed:', res.status, await res.text());
        process.exit(1);
    }
    const data = await res.json();
    env.accessToken = data.access_token;
    env.refreshToken = data.refresh_token;
}

function requireEnv() {
    for (const [k, v] of Object.entries(env)) {
        if (!v) {
            console.error(`Missing env var: FREEAGENT_${k.replace(/[A-Z]/g, c => '_' + c).toUpperCase().replace(/^_/, '')}`);
            process.exit(1);
        }
    }
}
