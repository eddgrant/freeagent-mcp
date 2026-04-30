#!/usr/bin/env node
// Empirical probe (rich edition): does the singular invoice.project field
// carry any load-bearing role on a multi-project invoice when the projects
// involved have *deliberately divergent* settings?
//
// The prior probe (probe-primary-project-semantics.mjs) ran against two
// pre-existing projects whose settings happened to be identical, so no
// choice of "primary" could produce observable difference. This script
// creates two throwaway projects with divergent settings (rates, billing
// periods, PO reference, project invoice sequence) and runs the same
// A/B/C/D variants under those conditions.
//
// Variants — all identical except project / project_ids:
//   A (baseline)     project=P_A   project_ids=[P_A, P_B]
//   B (swap singular) project=P_B  project_ids=[P_A, P_B]
//   C (swap order)   project=P_A   project_ids=[P_B, P_A]
//   D (omit singular) (absent)     project_ids=[P_A, P_B]
//
// Setup creates: 2 projects, 2 tasks, 2 timeslips. All recorded in the
// manifest. Cleanup is a separate explicit invocation.
//
// Run:     --contact <id|url> [--dated-on YYYY-MM-DD]
// Cleanup: --cleanup <manifest-path> [--yes]

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
if (!args.contact) {
    usage();
    process.exit(1);
}

await runProbe();

// ---------------------------------------------------------------------------

async function runProbe() {
    const contactUrl = toUrl(args.contact, 'contacts');
    const datedOn = args.datedOn || new Date().toISOString().slice(0, 10);
    const runId = `probe-primary-rich-${Date.now()}`;

    console.log('Probe configuration');
    console.log('  contact   ', contactUrl);
    console.log('  dated_on  ', datedOn);
    console.log('  run id    ', runId);
    console.log();

    const manifest = {
        runId,
        createdAt: new Date().toISOString(),
        contactUrl,
        createdProjects: [],   // [{ url, label }]
        createdTasks: [],      // [{ url, projectUrl }]
        createdTimeslips: [],  // [{ url, projectUrl }]
        createdInvoices: [],   // any drafts still around at end-of-run
    };
    const manifestPath = path.join(os.tmpdir(), `${runId}.json`);
    writeManifest(manifestPath, manifest);
    console.log(`Manifest: ${manifestPath}`);
    console.log();

    try {
        // 1) Setup: two projects with divergent settings.
        console.log('1) Setup — creating two projects with divergent settings');

        const projectA = await api('POST', '/projects', {
            project: {
                contact: contactUrl,
                name: `ProbePrimaryA ${runId}`,
                status: 'Active',
                currency: 'GBP',
                budget: 0,
                budget_units: 'Hours',
                normal_billing_rate: '100.00',
                billing_period: 'hour',
                hours_per_day: 8,
                contract_po_reference: 'PO-PRIMARY-A',
                uses_project_invoice_sequence: true,
            },
        });
        manifest.createdProjects.push({ url: projectA.project.url, label: 'P_A' });
        writeManifest(manifestPath, manifest);
        const pAUrl = projectA.project.url;
        console.log(`   P_A: ${pAUrl}`);
        console.log(`        rate=£100/hour  PO=PO-PRIMARY-A  uses_project_invoice_sequence=true`);

        const projectB = await api('POST', '/projects', {
            project: {
                contact: contactUrl,
                name: `ProbePrimaryB ${runId}`,
                status: 'Active',
                currency: 'GBP',
                budget: 0,
                budget_units: 'Hours',
                normal_billing_rate: '500.00',
                billing_period: 'day',
                hours_per_day: 4,
                contract_po_reference: 'PO-PRIMARY-B',
                uses_project_invoice_sequence: false,
            },
        });
        manifest.createdProjects.push({ url: projectB.project.url, label: 'P_B' });
        writeManifest(manifestPath, manifest);
        const pBUrl = projectB.project.url;
        console.log(`   P_B: ${pBUrl}`);
        console.log(`        rate=£500/day   PO=PO-PRIMARY-B  uses_project_invoice_sequence=false`);
        console.log();

        // 2) One billable task per project — NO billing_rate / billing_period
        //    set so the task inherits from the project.
        console.log('2) Setup — creating one billable task per project (inheriting project defaults)');
        const taskA = await api('POST', '/tasks', {
            task: { project: pAUrl, name: 'Probe task A', is_billable: true },
        });
        manifest.createdTasks.push({ url: taskA.task.url, projectUrl: pAUrl });
        writeManifest(manifestPath, manifest);
        console.log(`   Task on P_A: ${taskA.task.url}`);

        const taskB = await api('POST', '/tasks', {
            task: { project: pBUrl, name: 'Probe task B', is_billable: true },
        });
        manifest.createdTasks.push({ url: taskB.task.url, projectUrl: pBUrl });
        writeManifest(manifestPath, manifest);
        console.log(`   Task on P_B: ${taskB.task.url}`);
        console.log();

        // 3) One 1h timeslip per project.
        console.log('3) Setup — creating one 1h timeslip per project');
        const me = await api('GET', '/users/me');
        const userUrl = me.user.url;
        const slipA = await api('POST', '/timeslips', {
            timeslip: { task: taskA.task.url, user: userUrl, project: pAUrl, dated_on: datedOn, hours: '1.0', comment: `PROBE-PRIMARY-RICH ${runId}` },
        });
        manifest.createdTimeslips.push({ url: slipA.timeslip.url, projectUrl: pAUrl });
        writeManifest(manifestPath, manifest);
        console.log(`   timeslip on P_A: ${slipA.timeslip.url}`);

        const slipB = await api('POST', '/timeslips', {
            timeslip: { task: taskB.task.url, user: userUrl, project: pBUrl, dated_on: datedOn, hours: '1.0', comment: `PROBE-PRIMARY-RICH ${runId}` },
        });
        manifest.createdTimeslips.push({ url: slipB.timeslip.url, projectUrl: pBUrl });
        writeManifest(manifestPath, manifest);
        console.log(`   timeslip on P_B: ${slipB.timeslip.url}`);
        console.log();

        // 4) Run the four variants.
        const pA = idFromUrl(pAUrl);
        const pB = idFromUrl(pBUrl);
        const variantBuilders = {
            A: () => ({ project: pAUrl, project_ids: [pA, pB] }),
            B: () => ({ project: pBUrl, project_ids: [pA, pB] }),
            C: () => ({ project: pAUrl, project_ids: [pB, pA] }),
            D: () => ({ project_ids: [pA, pB] }),
        };
        const observations = {};

        for (const variant of ['A', 'B', 'C', 'D']) {
            console.log(`4.${variant}) Variant ${variant}`);
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
                console.log(`   POST failed: HTTP ${status}: ${truncate(errBody, 200)}`);
                observations[variant] = { status, errBody, partial };
                continue;
            }

            const invoice = createRes.invoice;
            const invoiceId = idFromUrl(invoice.url);
            manifest.createdInvoices.push({ url: invoice.url, reference: invoice.reference, variant });
            writeManifest(manifestPath, manifest);
            console.log(`   created invoice ${invoiceId} (ref ${invoice.reference})`);

            // Re-fetch nested for full state.
            const nested = await api('GET', `/invoices/${invoiceId}?nested_invoice_items=true`);
            const inv = nested.invoice;
            const items = (inv.invoice_items || []).map(it => ({
                position: it.position,
                item_type: it.item_type,
                description: it.description,
                quantity: it.quantity,
                price: it.price,
                sales_tax_rate: it.sales_tax_rate,
            }));

            const attached = {};
            for (const projectUrl of [pAUrl, pBUrl]) {
                const slips = await getAll(`/timeslips?project=${encodeURIComponent(projectUrl)}&nested=true`, 'timeslips');
                attached[idFromUrl(projectUrl)] = slips.filter(s => s.billed_on_invoice === invoice.url).length;
            }

            observations[variant] = {
                status,
                request: partial,
                response: {
                    reference: inv.reference,
                    project: inv.project,
                    po_reference: inv.po_reference,
                    currency: inv.currency,
                    bank_account: inv.bank_account,
                    payment_terms_in_days: inv.payment_terms_in_days,
                    invoice_items: items,
                },
                attached,
            };

            console.log(`   reference        = ${inv.reference}`);
            console.log(`   response.project = ${inv.project}`);
            console.log(`   po_reference     = ${inv.po_reference}`);
            console.log(`   currency         = ${inv.currency}`);
            console.log(`   bank_account     = ${inv.bank_account}`);
            console.log(`   ${items.length} invoice items:`);
            for (const it of items) {
                console.log(`     pos=${it.position} type=${it.item_type} qty=${it.quantity} price=${it.price} desc=${truncate(it.description, 60)}`);
            }
            console.log(`   attached: P_A=${attached[pA]}, P_B=${attached[pB]}`);

            await api('DELETE', `/invoices/${invoiceId}`);
            manifest.createdInvoices = manifest.createdInvoices.filter(i => i.url !== invoice.url);
            writeManifest(manifestPath, manifest);
            console.log(`   deleted invoice ${invoiceId}`);
            console.log();
        }

        printReport(observations, pA, pB);
    } finally {
        console.log();
        console.log('=== Manifest ===');
        console.log(`Path: ${manifestPath}`);
        console.log(JSON.stringify(readManifest(manifestPath), null, 2));
        console.log();
        console.log('NOTHING HAS BEEN DELETED at end-of-run from the manifest. Verify in the UI, then run:');
        console.log(`  node scripts/probe-primary-project-semantics-rich.mjs --cleanup ${manifestPath}`);
    }
}

function printReport(o, pA, pB) {
    console.log('=== Comparison report ===');
    console.log();
    function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

    const cols = [
        ['variant', 9],
        ['status', 8],
        ['reference', 14],
        ['po_reference', 18],
        ['response.project (last segment)', 18],
        ['#items', 8],
        [`P_A=${pA}`, 12],
        [`P_B=${pB}`, 12],
    ];
    console.log(cols.map(([h, w]) => pad(h, w)).join(''));
    console.log('-'.repeat(cols.reduce((a, [, w]) => a + w, 0)));
    for (const v of ['A', 'B', 'C', 'D']) {
        const ob = o[v];
        if (!ob) continue;
        if (ob.errBody) {
            console.log(pad(v, 9) + pad(ob.status, 8) + 'ERROR: ' + truncate(ob.errBody, 80));
            continue;
        }
        const r = ob.response;
        console.log(
            pad(v, 9) + pad(ob.status, 8) +
            pad(r.reference, 14) +
            pad(r.po_reference || '(none)', 18) +
            pad(r.project ? idFromUrl(r.project) : '(none)', 18) +
            pad(r.invoice_items.length, 8) +
            pad(ob.attached[pA], 12) + pad(ob.attached[pB], 12)
        );
    }
    console.log();

    // Show item details for each variant.
    for (const v of ['A', 'B', 'C', 'D']) {
        const ob = o[v];
        if (!ob || ob.errBody) continue;
        console.log(`Variant ${v} items:`);
        for (const it of ob.response.invoice_items) {
            console.log(`  pos=${it.position} type=${it.item_type} qty=${it.quantity} price=${it.price} desc=${truncate(it.description, 60)}`);
        }
    }
    console.log();

    // Verdicts.
    console.log('=== Verdicts ===');
    const A = o.A, B = o.B, C = o.C, D = o.D;

    if (D && D.errBody) {
        console.log(`H1: SUPPORTED — POST without singular project failed (HTTP ${D.status}). 'project' is required on the wire.`);
    } else if (D && A) {
        if (responsesEquivalent(A, D, ['project'])) {
            console.log("H1: REJECTED — POST without singular 'project' produced an equivalent invoice (modulo the response.project echo). The 'project' field is redundant when project_ids is set.");
        } else {
            console.log("H1: SUPPORTED — A vs D differ beyond the response.project echo:");
            describeDiff('A', 'D', A, D);
        }
    }

    if (A && B && !B.errBody) {
        if (responsesEquivalent(A, B, ['project'])) {
            console.log("H2: REJECTED — swapping the singular project (A vs B) produced equivalent invoices apart from the response.project echo. The value of 'project' does not influence anything observable.");
        } else {
            console.log("H2: SUPPORTED — A vs B differ:");
            describeDiff('A', 'B', A, B);
        }
    }

    if (A && C && !C.errBody) {
        if (responsesEquivalent(A, C, [])) {
            console.log("H3: REJECTED — reversing project_ids order (A vs C) produced equivalent invoices. Order does not matter.");
        } else {
            console.log("H3: SUPPORTED — A vs C differ:");
            describeDiff('A', 'C', A, C);
        }
    }
}

function responsesEquivalent(a, b, ignore) {
    const fields = ['reference', 'project', 'po_reference', 'currency', 'bank_account', 'payment_terms_in_days'];
    for (const f of fields) {
        if (ignore.includes(f)) continue;
        if (a.response[f] !== b.response[f]) return false;
    }
    const ai = a.response.invoice_items.map(stripPosition);
    const bi = b.response.invoice_items.map(stripPosition);
    if (JSON.stringify(ai) !== JSON.stringify(bi)) return false;
    if (a.attached.A !== b.attached.A || a.attached.B !== b.attached.B) {
        // attached counts keyed by id, not label — compare exhaustively
        const aKeys = Object.keys(a.attached).sort();
        const bKeys = Object.keys(b.attached).sort();
        if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false;
        for (const k of aKeys) if (a.attached[k] !== b.attached[k]) return false;
    }
    return true;
}

function stripPosition(it) { const { position, ...rest } = it; return rest; }

function describeDiff(la, lb, a, b) {
    const fields = ['reference', 'project', 'po_reference', 'currency', 'bank_account', 'payment_terms_in_days'];
    for (const f of fields) {
        if (a.response[f] !== b.response[f]) {
            console.log(`  ${f}: ${la}=${JSON.stringify(a.response[f])}  ${lb}=${JSON.stringify(b.response[f])}`);
        }
    }
    const ai = JSON.stringify(a.response.invoice_items.map(stripPosition));
    const bi = JSON.stringify(b.response.invoice_items.map(stripPosition));
    if (ai !== bi) {
        console.log(`  invoice_items differ:`);
        console.log(`    ${la}: ${ai}`);
        console.log(`    ${lb}: ${bi}`);
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
    for (const t of manifest.createdTasks) console.log(`  - task ${t.url}`);
    for (const p of manifest.createdProjects) console.log(`  - project ${p.url} (${p.label})`);
    console.log();
    if (!autoYes) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') { console.log('Aborted.'); return; }
    }
    // Order: invoices → timeslips → tasks → projects.
    for (const i of manifest.createdInvoices) await tryDelete('invoice', i.url);
    for (const t of manifest.createdTimeslips) await tryDelete('timeslip', t.url);
    for (const t of manifest.createdTasks) await tryDelete('task', t.url);
    for (const p of manifest.createdProjects) await tryDelete('project', p.url);
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
        else if (a === '--dated-on') out.datedOn = argv[++i];
        else if (a === '--cleanup') out.cleanup = argv[++i];
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
        else { console.error(`Unknown arg: ${a}`); usage(); process.exit(1); }
    }
    return out;
}

function usage() {
    console.error('Probe:   --contact <id|url> [--dated-on YYYY-MM-DD]');
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
