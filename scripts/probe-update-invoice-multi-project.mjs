#!/usr/bin/env node
// Probe whether an EXISTING invoice can be updated to span additional
// projects via PUT /v2/invoices/:id with the project_ids[] shape that
// works on create.
//
// Sequence:
//   1. Create a billable task + 1h timeslip on each project (primary + extras)
//   2. POST a draft invoice with the PRIMARY project only (single-project)
//      and include_timeslips=billed_grouped_by_timeslip_task. Confirm only
//      the primary's timeslip is attached.
//   3. PUT the invoice with project_ids=[primary, ...extras] and the same
//      include_timeslips. Capture response.
//   4. Re-fetch nested + re-list timeslips per project. Verdict:
//        - UPDATE WORKS         → extra projects' timeslips now attached
//        - UPDATE PARAM IGNORED → still only primary's
//        - UPDATE REJECTED      → API returned a non-2xx
//
// Modes mirror probe-multi-project-invoice.mjs:
//
//   Probe:    node scripts/probe-update-invoice-multi-project.mjs \
//               --contact <id|url> --project <id|url> \
//               --extra-project <id|url> [--extra-project <id|url>]... \
//               [--dated-on YYYY-MM-DD]
//
//   Cleanup:  node scripts/probe-update-invoice-multi-project.mjs \
//               --cleanup <manifest-path> [--yes]

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
if (!args.contact || !args.project || args.extraProjects.length === 0) {
    usage();
    process.exit(1);
}

await runProbe();

// ---------------------------------------------------------------------------

async function runProbe() {
    const contactUrl = toUrl(args.contact, 'contacts');
    const primaryProjectUrl = toUrl(args.project, 'projects');
    const extraProjectUrls = args.extraProjects.map(p => toUrl(p, 'projects'));
    const datedOn = args.datedOn || new Date().toISOString().slice(0, 10);
    const runId = `probe-update-${Date.now()}`;
    const allProjectUrls = [primaryProjectUrl, ...extraProjectUrls];

    console.log('Probe configuration');
    console.log('  contact            ', contactUrl);
    console.log('  primary project    ', primaryProjectUrl);
    console.log('  extra project(s)   ', extraProjectUrls);
    console.log('  dated_on           ', datedOn);
    console.log('  run id             ', runId);
    console.log();

    const manifest = {
        runId,
        createdAt: new Date().toISOString(),
        contactUrl,
        primaryProjectUrl,
        extraProjectUrls,
        createdTasks: [],
        createdTimeslips: [],
        createdInvoice: null,
    };

    const manifestPath = path.join(os.tmpdir(), `${runId}.json`);
    writeManifest(manifestPath, manifest);
    console.log(`Manifest will be written to: ${manifestPath}`);
    console.log();

    try {
        console.log('1) Resolving current user');
        const me = await api('GET', '/users/me');
        const userUrl = me.user.url;
        console.log('   user:', userUrl);
        console.log();

        console.log('2) Setup — task + 1h timeslip per project');
        for (const projectUrl of allProjectUrls) {
            const projectId = idFromUrl(projectUrl);
            const tasks = await getAll(`/tasks?project=${encodeURIComponent(projectUrl)}`, 'tasks');
            let task = tasks.find(t => t.is_billable && t.status === 'Active') || tasks.find(t => t.is_billable);
            if (!task) {
                const created = await api('POST', '/tasks', {
                    task: { project: projectUrl, name: `Probe task ${runId}`, is_billable: true, billing_rate: '1.00' },
                });
                task = created.task;
                manifest.createdTasks.push({ url: task.url, projectUrl });
                writeManifest(manifestPath, manifest);
                console.log(`   project ${projectId}: created task ${task.url}`);
            } else {
                console.log(`   project ${projectId}: using existing task ${task.url}`);
            }
            const slip = await api('POST', '/timeslips', {
                timeslip: {
                    task: task.url, user: userUrl, project: projectUrl,
                    dated_on: datedOn, hours: '1.0',
                    comment: `PROBE-UPDATE-MULTI-PROJECT ${runId}`,
                },
            });
            manifest.createdTimeslips.push({ url: slip.timeslip.url, projectUrl });
            writeManifest(manifestPath, manifest);
            console.log(`   project ${projectId}: created timeslip ${slip.timeslip.url}`);
        }
        console.log();

        console.log('3) POST /invoices — single-project to start (primary only)');
        const createBody = {
            invoice: {
                contact: contactUrl,
                project: primaryProjectUrl,
                dated_on: datedOn,
                payment_terms_in_days: 30,
                include_timeslips: 'billed_grouped_by_timeslip_task',
            },
        };
        const createRes = await api('POST', '/invoices', createBody);
        const invoice = createRes.invoice;
        const invoiceId = idFromUrl(invoice.url);
        manifest.createdInvoice = { url: invoice.url, reference: invoice.reference };
        writeManifest(manifestPath, manifest);
        console.log(`   created invoice ${invoiceId} (ref ${invoice.reference}), status=${invoice.status}`);

        // Sanity check: only primary's timeslip should be attached.
        const beforeAttached = await countAttachedPerProject(invoice.url, allProjectUrls);
        console.log('   timeslips attached after create:', beforeAttached);
        console.log();

        console.log('4) PUT /invoices/:id — adding project_ids[primary, ...extras]');
        const projectIds = [primaryProjectUrl, ...extraProjectUrls].map(idFromUrl);
        const updateBody = {
            invoice: {
                project_ids: projectIds,
                include_timeslips: 'billed_grouped_by_timeslip_task',
            },
        };
        console.log('   request body:', JSON.stringify(updateBody, null, 2));

        let updateOk = true;
        try {
            await api('PUT', `/invoices/${invoiceId}`, updateBody);
        } catch (err) {
            updateOk = false;
            console.error('   PUT failed:', err.status, err.body);
        }
        console.log();

        if (!updateOk) {
            console.log('=== VERDICT ===');
            console.log('UPDATE REJECTED: API refused the PUT.');
            return;
        }

        console.log('5) Re-fetching invoice nested + re-counting attached timeslips');
        const nested = await api('GET', `/invoices/${invoiceId}?nested_invoice_items=true`);
        const items = nested.invoice.invoice_items || [];
        console.log(`   ${items.length} invoice items returned`);
        for (const it of items) {
            console.log(`     - type=${it.item_type} qty=${it.quantity} desc=${truncate(it.description, 80)}`);
        }
        const afterAttached = await countAttachedPerProject(invoice.url, allProjectUrls);
        console.log('   timeslips attached after update:', afterAttached);
        console.log();

        const extraCountBefore = sumExceptPrimary(beforeAttached, primaryProjectUrl);
        const extraCountAfter = sumExceptPrimary(afterAttached, primaryProjectUrl);

        console.log('=== VERDICT ===');
        if (extraCountAfter > extraCountBefore) {
            console.log(`UPDATE WORKS: extra-project timeslips went from ${extraCountBefore} → ${extraCountAfter}.`);
            console.log('PUT /invoices/:id with project_ids[] (incl. primary) attaches additional projects and pulls their timeslips.');
        } else {
            console.log(`UPDATE PARAM IGNORED: extra-project timeslips remain at ${extraCountAfter} after the PUT.`);
            console.log('You can create multi-project invoices on POST, but cannot extend an existing single-project invoice.');
        }
    } finally {
        console.log();
        console.log('=== Manifest ===');
        console.log(`Path: ${manifestPath}`);
        console.log(JSON.stringify(readManifest(manifestPath), null, 2));
        console.log();
        console.log('NOTHING HAS BEEN DELETED. Verify in the FreeAgent UI, then run:');
        console.log(`  node scripts/probe-update-invoice-multi-project.mjs --cleanup ${manifestPath}`);
    }
}

async function countAttachedPerProject(invoiceUrl, projectUrls) {
    const out = {};
    for (const projectUrl of projectUrls) {
        const slips = await getAll(`/timeslips?project=${encodeURIComponent(projectUrl)}&nested=true`, 'timeslips');
        out[idFromUrl(projectUrl)] = slips.filter(s => s.billed_on_invoice === invoiceUrl).length;
    }
    return out;
}

function sumExceptPrimary(counts, primaryUrl) {
    const primaryId = idFromUrl(primaryUrl);
    return Object.entries(counts).reduce((acc, [id, n]) => acc + (id === primaryId ? 0 : n), 0);
}

async function runCleanup(manifestPath, autoYes) {
    requireEnv();
    const manifest = readManifest(manifestPath);
    console.log(`Cleanup using manifest: ${manifestPath}`);
    console.log(`Run id: ${manifest.runId}  (created ${manifest.createdAt})`);
    console.log();
    console.log('Will delete:');
    if (manifest.createdInvoice) {
        console.log(`  - invoice ${manifest.createdInvoice.url} (ref ${manifest.createdInvoice.reference})`);
    }
    console.log(`  - ${manifest.createdTimeslips.length} timeslip(s):`);
    for (const t of manifest.createdTimeslips) console.log(`      ${t.url}`);
    console.log(`  - ${manifest.createdTasks.length} task(s):`);
    for (const t of manifest.createdTasks) console.log(`      ${t.url}`);
    console.log();

    if (!autoYes) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const answer = (await rl.question('Proceed with deletion? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') {
            console.log('Aborted. Nothing deleted.');
            return;
        }
    }

    if (manifest.createdInvoice) await tryDelete('invoice', manifest.createdInvoice.url);
    for (const t of manifest.createdTimeslips) await tryDelete('timeslip', t.url);
    for (const t of manifest.createdTasks) await tryDelete('task', t.url);

    console.log();
    console.log(`Cleanup complete. Manifest left at ${manifestPath} for your records.`);
}

async function tryDelete(kind, url) {
    try { await api('DELETE', url); console.log(`  deleted ${kind} ${url}`); }
    catch (err) { console.error(`  FAILED to delete ${kind} ${url} — status ${err.status}: ${err.body}`); }
}

function parseArgs(argv) {
    const out = { extraProjects: [], yes: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--contact') out.contact = argv[++i];
        else if (a === '--project') out.project = argv[++i];
        else if (a === '--extra-project') out.extraProjects.push(argv[++i]);
        else if (a === '--dated-on') out.datedOn = argv[++i];
        else if (a === '--cleanup') out.cleanup = argv[++i];
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
        else { console.error(`Unknown arg: ${a}`); usage(); process.exit(1); }
    }
    return out;
}

function usage() {
    console.error('Probe mode:   --contact <id|url> --project <id|url> --extra-project <id|url> [--extra-project ...] [--dated-on YYYY-MM-DD]');
    console.error('Cleanup mode: --cleanup <manifest-path> [--yes]');
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
