#!/usr/bin/env node
// Empirical probe: does the singular invoice.project field carry any
// load-bearing role on a multi-project invoice, or is it cosmetic when
// invoice.project_ids is present?
//
// Test design (see conversation transcript for rationale):
//
//   Setup once: 1 unbilled timeslip on each of two projects (P1, P2),
//   identically dated and commented. All variants reuse these timeslips;
//   between variants we DELETE the draft invoice (which un-bills the
//   timeslips) and move on.
//
//   Variants — all identical except project / project_ids:
//     A (baseline)     project=P1    project_ids=[P1, P2]
//     B (swap singular) project=P2   project_ids=[P1, P2]
//     C (swap order)   project=P1    project_ids=[P2, P1]
//     D (omit singular) (absent)     project_ids=[P1, P2]
//
//   For each variant we capture: POST status, response invoice.project,
//   currency, ordered invoice_items, attached-timeslip counts per project,
//   and the full invoice JSON for diffing.
//
// Modes mirror the earlier probes:
//
//   Run:     --contact <id|url> --project <id|url> --extra-project <id|url> [--dated-on YYYY-MM-DD]
//   Cleanup: --cleanup <manifest-path> [--yes]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const API_BASE = 'https://api.freeagent.com/v2';

const env = {
    clientId: process.env.FREEAGENT_CLIENT_ID,
    clientSecret: process.env.FREEAGENT_CLIENT_SECRET,
    accessToken: process.env.FREEAGENT_ACCESS_TOKEN,
    refreshToken: process.env.FREEAGENT_REFRESH_TOKEN,
};

const args = parseArgs(process.argv.slice(2));

if (args.cleanup) {
    await runCleanup(args.cleanup, args.yes);
    process.exit(0);
}

requireEnv();
if (!args.contact || !args.project || !args.extraProject) {
    usage();
    process.exit(1);
}

await runProbe();

// ---------------------------------------------------------------------------

async function runProbe() {
    const contactUrl = toUrl(args.contact, 'contacts');
    const p1Url = toUrl(args.project, 'projects');
    const p2Url = toUrl(args.extraProject, 'projects');
    const p1 = idFromUrl(p1Url);
    const p2 = idFromUrl(p2Url);
    const datedOn = args.datedOn || new Date().toISOString().slice(0, 10);
    const runId = `probe-primary-${Date.now()}`;

    console.log('Probe configuration');
    console.log('  contact   ', contactUrl);
    console.log('  P1        ', p1Url);
    console.log('  P2        ', p2Url);
    console.log('  dated_on  ', datedOn);
    console.log('  run id    ', runId);
    console.log();

    const manifest = {
        runId,
        createdAt: new Date().toISOString(),
        contactUrl,
        p1Url,
        p2Url,
        createdTimeslips: [],
        createdInvoices: [], // any drafts still around at end-of-run (should be 0 after happy path)
    };
    const manifestPath = path.join(os.tmpdir(), `${runId}.json`);
    writeManifest(manifestPath, manifest);
    console.log(`Manifest: ${manifestPath}`);
    console.log();

    const variantBuilders = {
        A: () => ({ project: p1Url, project_ids: [p1, p2] }),
        B: () => ({ project: p2Url, project_ids: [p1, p2] }),
        C: () => ({ project: p1Url, project_ids: [p2, p1] }),
        D: () => ({ project_ids: [p1, p2] }), // singular omitted entirely
    };
    const observations = {};

    try {
        // 1) Setup: one timeslip on each project.
        console.log('1) Setup — creating one 1h timeslip per project');
        const me = await api('GET', '/users/me');
        const userUrl = me.user.url;
        for (const projectUrl of [p1Url, p2Url]) {
            const tasks = await getAll(`/tasks?project=${encodeURIComponent(projectUrl)}`, 'tasks');
            const task = tasks.find(t => t.is_billable && t.status === 'Active') || tasks.find(t => t.is_billable);
            if (!task) {
                console.error(`   No billable task on project ${idFromUrl(projectUrl)} — pick a different project pair.`);
                process.exit(1);
            }
            const slip = await api('POST', '/timeslips', {
                timeslip: {
                    task: task.url, user: userUrl, project: projectUrl,
                    dated_on: datedOn, hours: '1.0',
                    comment: `PROBE-PRIMARY-SEMANTICS ${runId}`,
                },
            });
            manifest.createdTimeslips.push({ url: slip.timeslip.url, projectUrl });
            writeManifest(manifestPath, manifest);
            console.log(`   project ${idFromUrl(projectUrl)}: timeslip ${slip.timeslip.url} (task ${task.url})`);
        }
        console.log();

        // 2) Run variants in order, deleting between.
        for (const variant of ['A', 'B', 'C', 'D']) {
            console.log(`2.${variant}) Variant ${variant}`);
            const partial = variantBuilders[variant]();
            const body = {
                invoice: {
                    contact: contactUrl,
                    dated_on: datedOn,
                    payment_terms_in_days: 30,
                    include_timeslips: 'billed_grouped_by_timeslip_task',
                    ...partial,
                },
            };
            console.log('   request:', JSON.stringify(partial));

            let createRes, status, errBody;
            try {
                createRes = await api('POST', '/invoices', body);
                status = 200;
            } catch (err) {
                status = err.status;
                errBody = err.body;
                console.log(`   POST failed: HTTP ${status}`);
                observations[variant] = { status, errBody, body, partial };
                continue;
            }

            const invoice = createRes.invoice;
            const invoiceId = idFromUrl(invoice.url);
            manifest.createdInvoices.push({ url: invoice.url, reference: invoice.reference, variant });
            writeManifest(manifestPath, manifest);
            console.log(`   created invoice ${invoiceId} (ref ${invoice.reference})`);

            // Re-fetch nested to get invoice_items.
            const nested = await api('GET', `/invoices/${invoiceId}?nested_invoice_items=true`);
            const items = (nested.invoice.invoice_items || []).map(it => ({
                position: it.position,
                item_type: it.item_type,
                description: it.description,
                quantity: it.quantity,
                price: it.price,
                sales_tax_rate: it.sales_tax_rate,
            }));

            // Per-project attached counts.
            const attached = {};
            for (const projectUrl of [p1Url, p2Url]) {
                const slips = await getAll(`/timeslips?project=${encodeURIComponent(projectUrl)}&nested=true`, 'timeslips');
                attached[idFromUrl(projectUrl)] = slips.filter(s => s.billed_on_invoice === invoice.url).length;
            }

            observations[variant] = {
                status,
                request: partial,
                response: {
                    project: nested.invoice.project,
                    currency: nested.invoice.currency,
                    bank_account: nested.invoice.bank_account,
                    payment_terms_in_days: nested.invoice.payment_terms_in_days,
                    invoice_items: items,
                },
                attached,
                fullInvoice: nested.invoice, // for deep diff
            };

            console.log(`   response.project = ${nested.invoice.project}`);
            console.log(`   response.currency = ${nested.invoice.currency}`);
            console.log(`   ${items.length} invoice items:`);
            for (const it of items) {
                console.log(`     pos=${it.position} type=${it.item_type} qty=${it.quantity} price=${it.price} desc=${truncate(it.description, 60)}`);
            }
            console.log(`   timeslips attached: P1=${attached[p1]}, P2=${attached[p2]}`);

            // Tear down for next variant.
            await api('DELETE', `/invoices/${invoiceId}`);
            manifest.createdInvoices = manifest.createdInvoices.filter(i => i.url !== invoice.url);
            writeManifest(manifestPath, manifest);
            console.log(`   deleted invoice ${invoiceId}`);
            console.log();
        }

        // 3) Print comparison report.
        printReport(observations, p1, p2);
    } finally {
        console.log();
        console.log('=== Manifest ===');
        console.log(`Path: ${manifestPath}`);
        console.log(JSON.stringify(readManifest(manifestPath), null, 2));
        console.log();
        console.log('NOTHING HAS BEEN DELETED at end-of-run from the manifest. Verify in the UI, then run:');
        console.log(`  node scripts/probe-primary-project-semantics.mjs --cleanup ${manifestPath}`);
    }
}

function printReport(observations, p1, p2) {
    console.log('=== Comparison report ===');
    console.log();
    const rows = ['A', 'B', 'C', 'D'];
    const widths = { variant: 8, status: 8, project: 60, currency: 10, items: 8, p1: 6, p2: 6 };

    function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

    console.log(
        pad('variant', widths.variant) + pad('status', widths.status) +
        pad('resp.project', widths.project) + pad('currency', widths.currency) +
        pad('#items', widths.items) + pad(`P1=${p1}`, widths.p1) + pad(`P2=${p2}`, widths.p2)
    );
    console.log('-'.repeat(widths.variant + widths.status + widths.project + widths.currency + widths.items + widths.p1 + widths.p2));
    for (const v of rows) {
        const o = observations[v];
        if (!o) { console.log(pad(v, widths.variant) + 'no data'); continue; }
        if (o.errBody) {
            console.log(pad(v, widths.variant) + pad(o.status, widths.status) + 'ERROR: ' + truncate(o.errBody, 80));
            continue;
        }
        const r = o.response;
        console.log(
            pad(v, widths.variant) + pad(o.status, widths.status) +
            pad(r.project || '(none)', widths.project) + pad(r.currency, widths.currency) +
            pad(r.invoice_items.length, widths.items) +
            pad(o.attached[p1], widths.p1) + pad(o.attached[p2], widths.p2)
        );
    }
    console.log();

    // Pairwise verdicts.
    console.log('=== Verdicts ===');
    const A = observations.A, B = observations.B, C = observations.C, D = observations.D;

    if (D && D.errBody) {
        console.log(`H1: SUPPORTED — POST without singular project failed (HTTP ${D.status}). The 'project' field is required on the wire.`);
    } else if (D && A) {
        const sameItems = JSON.stringify(itemsForCompare(A.response.invoice_items)) === JSON.stringify(itemsForCompare(D.response.invoice_items));
        const sameAttached = A.attached[p1] === D.attached[p1] && A.attached[p2] === D.attached[p2];
        if (sameItems && sameAttached) {
            console.log("H1: REJECTED — POST without singular 'project' succeeded with the same items as baseline. The 'project' field is redundant when project_ids is present.");
        } else {
            console.log("H1: PARTIALLY SUPPORTED — POST without 'project' succeeded but produced different items/attachments than baseline. See diff below.");
            diffResponses('A', 'D', A, D);
        }
    }

    if (A && B && !B.errBody) {
        const ignoreProjectField = (r) => ({ ...r, project: '<ignored>' });
        const aShape = JSON.stringify({ ...ignoreProjectField(A.response), invoice_items: itemsForCompare(A.response.invoice_items) });
        const bShape = JSON.stringify({ ...ignoreProjectField(B.response), invoice_items: itemsForCompare(B.response.invoice_items) });
        if (aShape === bShape && A.attached[p1] === B.attached[p1] && A.attached[p2] === B.attached[p2]) {
            console.log('H2: REJECTED — swapping the singular project (A vs B) produced identical invoices apart from the response.project echo. The value of `project` does not influence anything observable.');
        } else {
            console.log('H2: SUPPORTED — A and B differ beyond the response.project echo. The singular project is load-bearing.');
            diffResponses('A', 'B', A, B);
        }
    }

    if (A && C && !C.errBody) {
        const aItems = JSON.stringify(itemsForCompare(A.response.invoice_items));
        const cItems = JSON.stringify(itemsForCompare(C.response.invoice_items));
        if (aItems === cItems) {
            console.log('H3: REJECTED — reversing project_ids order (A vs C) produced identical invoice items. Order does not matter.');
        } else {
            console.log('H3: SUPPORTED — A and C differ in invoice_items. The order of project_ids matters.');
            diffResponses('A', 'C', A, C);
        }
    }
}

function itemsForCompare(items) {
    // Strip URLs and IDs that vary across runs.
    return items.map(it => ({
        item_type: it.item_type,
        description: it.description,
        quantity: it.quantity,
        price: it.price,
        sales_tax_rate: it.sales_tax_rate,
    }));
}

function diffResponses(la, lb, a, b) {
    console.log(`  diff ${la} vs ${lb}:`);
    const fields = ['project', 'currency', 'bank_account', 'payment_terms_in_days'];
    for (const f of fields) {
        if (a.response[f] !== b.response[f]) {
            console.log(`    ${f}: ${la}=${a.response[f]}  ${lb}=${b.response[f]}`);
        }
    }
    const ai = itemsForCompare(a.response.invoice_items);
    const bi = itemsForCompare(b.response.invoice_items);
    if (JSON.stringify(ai) !== JSON.stringify(bi)) {
        console.log(`    invoice_items differ:`);
        console.log(`      ${la}: ${JSON.stringify(ai)}`);
        console.log(`      ${lb}: ${JSON.stringify(bi)}`);
    }
}

async function runCleanup(manifestPath, autoYes) {
    requireEnv();
    const manifest = readManifest(manifestPath);
    console.log(`Cleanup using manifest: ${manifestPath}`);
    console.log(`Run id: ${manifest.runId}`);
    console.log();
    console.log('Will delete:');
    for (const i of manifest.createdInvoices) console.log(`  - invoice ${i.url} (ref ${i.reference}, variant ${i.variant})`);
    for (const t of manifest.createdTimeslips) console.log(`  - timeslip ${t.url}`);
    console.log();
    if (!autoYes) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') { console.log('Aborted.'); return; }
    }
    for (const i of manifest.createdInvoices) await tryDelete('invoice', i.url);
    for (const t of manifest.createdTimeslips) await tryDelete('timeslip', t.url);
    console.log('Cleanup complete.');
}

async function tryDelete(kind, url) {
    try { await api('DELETE', url); console.log(`  deleted ${kind} ${url}`); }
    catch (err) { console.error(`  FAILED to delete ${kind} ${url}: ${err.status} ${err.body}`); }
}

function parseArgs(argv) {
    const out = { yes: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--contact') out.contact = argv[++i];
        else if (a === '--project') out.project = argv[++i];
        else if (a === '--extra-project') out.extraProject = argv[++i];
        else if (a === '--dated-on') out.datedOn = argv[++i];
        else if (a === '--cleanup') out.cleanup = argv[++i];
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
        else { console.error(`Unknown arg: ${a}`); usage(); process.exit(1); }
    }
    return out;
}

function usage() {
    console.error('Probe:   --contact <id|url> --project <id|url> --extra-project <id|url> [--dated-on YYYY-MM-DD]');
    console.error('Cleanup: --cleanup <manifest-path> [--yes]');
}

function requireEnv() {
    for (const [k, v] of Object.entries(env)) {
        if (!v) { console.error(`Missing env var: FREEAGENT_${k.replace(/[A-Z]/g, c => '_' + c).toUpperCase().replace(/^_/, '')}`); process.exit(1); }
    }
}

function toUrl(idOrUrl, resource) {
    if (/^https?:\/\//.test(idOrUrl)) return idOrUrl;
    if (!/^\d+$/.test(idOrUrl)) { console.error(`Expected numeric id or full URL for ${resource}, got: ${idOrUrl}`); process.exit(1); }
    return `${API_BASE}/${resource}/${idOrUrl}`;
}

function idFromUrl(url) { return url.split('/').pop(); }
function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function writeManifest(p, m) { fs.writeFileSync(p, JSON.stringify(m, null, 2)); }
function readManifest(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function api(method, p, body, { retried = false } = {}) {
    const url = p.startsWith('http') ? p : `${API_BASE}${p}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${env.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { await refresh(); return api(method, p, body, { retried: true }); }
    const text = await res.text();
    if (!res.ok) { const err = new Error(`HTTP ${res.status} for ${method} ${p}`); err.status = res.status; err.body = text; throw err; }
    if (res.status === 204 || !text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

async function getAll(p, key) {
    const out = [];
    const sep = p.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
        const data = await api('GET', `${p}${sep}per_page=100&page=${page}`);
        const items = data?.[key] || [];
        out.push(...items);
        if (items.length < 100) break;
    }
    return out;
}

async function refresh() {
    console.error('   (refreshing access token)');
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
    if (!res.ok) { console.error('Token refresh failed:', res.status, await res.text()); process.exit(1); }
    const data = await res.json();
    env.accessToken = data.access_token;
    env.refreshToken = data.refresh_token;
}
