#!/usr/bin/env node
// Probe whether POST /v2/invoices on the FreeAgent public API accepts
// project_ids[] (the shape the web UI sends to its internal Turbo endpoint).
//
// The docs at dev.freeagent.com/docs/invoices document only a single
// `project` field. This script tests whether the public controller
// silently accepts the param and pulls timeslips from multiple projects.
//
// Two modes:
//
// 1. Run the probe (default):
//
//      FREEAGENT_CLIENT_ID=... FREEAGENT_CLIENT_SECRET=... \
//      FREEAGENT_ACCESS_TOKEN=... FREEAGENT_REFRESH_TOKEN=... \
//      node scripts/probe-multi-project-invoice.mjs \
//        --contact <id-or-url> \
//        --project <id-or-url> \
//        --extra-project <id-or-url> [--extra-project <id-or-url>]...
//
//    This creates one billable task per project (only if the project has
//    none), creates one 1-hour timeslip per project, then creates a draft
//    invoice with `project_ids[]` and reports the verdict. ALL artifacts
//    are recorded in a manifest file printed at the end. NOTHING is
//    deleted in this mode.
//
// 2. Cleanup using the manifest produced by mode 1:
//
//      node scripts/probe-multi-project-invoice.mjs --cleanup <manifest-path> [--yes]
//
//    Verify the artifacts in the FreeAgent UI first. The script prints the
//    list and waits for an interactive y/N confirmation unless --yes is
//    passed.

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

// Probe mode requires all four env vars and the create args.
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
    const runId = `probe-${Date.now()}`;
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
        createdTasks: [],     // [{ url, projectUrl }]
        createdTimeslips: [], // [{ url, projectUrl }]
        createdInvoice: null, // { url, reference }
    };

    // Always write the manifest path up front so the user can find it even
    // if the script crashes partway through.
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

        console.log('2) Pre-flight — pre-existing unbilled timeslips per project');
        const preExistingPerProject = {};
        for (const url of allProjectUrls) {
            const id = idFromUrl(url);
            const slips = await getAll(`/timeslips?view=unbilled&project=${encodeURIComponent(url)}&nested=true`, 'timeslips');
            preExistingPerProject[url] = slips.map(s => s.url);
            console.log(`   project ${id}: ${slips.length} pre-existing unbilled timeslips`);
        }
        if (Object.values(preExistingPerProject).some(arr => arr.length > 0)) {
            console.log('   NOTE: pre-existing unbilled timeslips will also be attached to the draft invoice if include_timeslips matches them.');
            console.log('         The draft will be reported in the manifest; deleting the draft un-bills them again.');
        }
        console.log();

        console.log('3) Setup — ensuring a billable task on each project and creating one 1h timeslip per project');
        const taskPerProject = {};
        for (const projectUrl of allProjectUrls) {
            const projectId = idFromUrl(projectUrl);

            // Find an existing billable task on this project.
            const tasks = await getAll(`/tasks?project=${encodeURIComponent(projectUrl)}`, 'tasks');
            let task = tasks.find(t => t.is_billable && t.status === 'Active') || tasks.find(t => t.is_billable);
            if (!task) {
                console.log(`   project ${projectId}: no billable task — creating temporary task`);
                const created = await api('POST', '/tasks', {
                    task: {
                        project: projectUrl,
                        name: `Probe task ${runId}`,
                        is_billable: true,
                        billing_rate: '1.00',
                    },
                });
                task = created.task;
                manifest.createdTasks.push({ url: task.url, projectUrl });
                writeManifest(manifestPath, manifest);
                console.log(`   project ${projectId}: created task ${task.url}`);
            } else {
                console.log(`   project ${projectId}: using existing task ${task.url}`);
            }
            taskPerProject[projectUrl] = task.url;

            // Create a 1-hour timeslip.
            const slip = await api('POST', '/timeslips', {
                timeslip: {
                    task: task.url,
                    user: userUrl,
                    project: projectUrl,
                    dated_on: datedOn,
                    hours: '1.0',
                    comment: `PROBE-MULTI-PROJECT-INVOICE ${runId}`,
                },
            });
            manifest.createdTimeslips.push({ url: slip.timeslip.url, projectUrl });
            writeManifest(manifestPath, manifest);
            console.log(`   project ${projectId}: created timeslip ${slip.timeslip.url}`);
        }
        console.log();

        console.log('4) POST /invoices with project + project_ids[]');
        // Per a forum reply (api-discuss.freeagent.com): project_ids must be
        // an array of *numeric* IDs (not URLs), AND must include the primary
        // project ID alongside the extras. The `project` URL stays.
        const projectIds = [primaryProjectUrl, ...extraProjectUrls].map(idFromUrl);
        const body = {
            invoice: {
                contact: contactUrl,
                project: primaryProjectUrl,
                project_ids: projectIds,
                dated_on: datedOn,
                payment_terms_in_days: 30,
                include_timeslips: 'billed_grouped_by_timeslip_task',
            },
        };
        console.log('   request body:', JSON.stringify(body, null, 2));

        let createdInvoice;
        try {
            const res = await api('POST', '/invoices', body);
            createdInvoice = res.invoice;
        } catch (err) {
            console.error();
            console.error('VERDICT: API REJECTED the request.');
            console.error('  status:', err.status);
            console.error('  body:  ', err.body);
            console.error();
            console.error(`Manifest (timeslips/tasks need cleanup): ${manifestPath}`);
            console.error(`Run: node scripts/probe-multi-project-invoice.mjs --cleanup ${manifestPath}`);
            process.exit(2);
        }

        const invoiceId = idFromUrl(createdInvoice.url);
        manifest.createdInvoice = { url: createdInvoice.url, reference: createdInvoice.reference };
        writeManifest(manifestPath, manifest);
        console.log(`   created invoice ${invoiceId} (ref ${createdInvoice.reference}), status=${createdInvoice.status}`);
        console.log();

        console.log('5) Re-fetching invoice nested and inspecting which timeslips it covers');
        const nested = await api('GET', `/invoices/${invoiceId}?nested_invoice_items=true`);
        const items = nested.invoice.invoice_items || [];
        console.log(`   ${items.length} invoice items returned`);
        for (const it of items) {
            console.log(`     - type=${it.item_type} qty=${it.quantity} desc=${truncate(it.description, 80)}`);
        }
        console.log();

        console.log('6) Re-listing timeslips per project to see which were billed on this invoice');
        let primaryBilled = 0;
        let extraBilled = 0;
        for (const projectUrl of allProjectUrls) {
            const projectId = idFromUrl(projectUrl);
            const allSlips = await getAll(`/timeslips?project=${encodeURIComponent(projectUrl)}&nested=true`, 'timeslips');
            const billedHere = allSlips.filter(s => s.billed_on_invoice === createdInvoice.url);
            const isPrimary = projectUrl === primaryProjectUrl;
            if (isPrimary) primaryBilled = billedHere.length;
            else extraBilled += billedHere.length;
            console.log(`   project ${projectId} (${isPrimary ? 'primary' : 'extra'}): ${billedHere.length} timeslips attached to invoice ${invoiceId}`);
        }

        console.log();
        console.log('=== VERDICT ===');
        if (extraBilled > 0) {
            console.log(`MULTI-PROJECT WORKS: ${extraBilled} timeslip(s) from extra project(s) were attached alongside ${primaryBilled} from the primary.`);
            console.log('The public API silently accepts invoice[project_ids][] the same way the web UI does.');
        } else if (primaryBilled > 0) {
            console.log(`PARAM IGNORED: ${primaryBilled} timeslip(s) attached, all from the primary project. invoice[project_ids][] appears to be silently dropped.`);
        } else {
            console.log('INCONCLUSIVE: no timeslips were attached to the invoice.');
        }
    } finally {
        console.log();
        console.log('=== Manifest ===');
        console.log(`Path: ${manifestPath}`);
        console.log(JSON.stringify(readManifest(manifestPath), null, 2));
        console.log();
        console.log('NOTHING HAS BEEN DELETED. Verify in the FreeAgent UI, then run:');
        console.log(`  node scripts/probe-multi-project-invoice.mjs --cleanup ${manifestPath}`);
    }
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

    // Order matters: invoice first (un-bills its timeslips), then timeslips,
    // then tasks (a task with timeslips against it cannot be deleted).
    if (manifest.createdInvoice) {
        await tryDelete('invoice', manifest.createdInvoice.url);
    }
    for (const t of manifest.createdTimeslips) {
        await tryDelete('timeslip', t.url);
    }
    for (const t of manifest.createdTasks) {
        await tryDelete('task', t.url);
    }

    console.log();
    console.log(`Cleanup complete. Manifest left at ${manifestPath} for your records.`);
}

async function tryDelete(kind, url) {
    try {
        await api('DELETE', url);
        console.log(`  deleted ${kind} ${url}`);
    } catch (err) {
        console.error(`  FAILED to delete ${kind} ${url} — status ${err.status}: ${err.body}`);
    }
}

// ---------------------------------------------------------------------------

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
    console.error('Probe mode:');
    console.error('  node scripts/probe-multi-project-invoice.mjs \\');
    console.error('    --contact <id|url> --project <id|url> --extra-project <id|url> [--extra-project ...] [--dated-on YYYY-MM-DD]');
    console.error();
    console.error('Cleanup mode:');
    console.error('  node scripts/probe-multi-project-invoice.mjs --cleanup <manifest-path> [--yes]');
}

function requireEnv() {
    for (const [k, v] of Object.entries(env)) {
        if (!v) {
            console.error(`Missing env var: FREEAGENT_${k.replace(/[A-Z]/g, c => '_' + c).toUpperCase().replace(/^_/, '')}`);
            process.exit(1);
        }
    }
}

function toUrl(idOrUrl, resource) {
    if (/^https?:\/\//.test(idOrUrl)) return idOrUrl;
    if (!/^\d+$/.test(idOrUrl)) {
        console.error(`Expected numeric id or full URL for ${resource}, got: ${idOrUrl}`);
        process.exit(1);
    }
    return `${API_BASE}/${resource}/${idOrUrl}`;
}

function idFromUrl(url) {
    return url.split('/').pop();
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function writeManifest(p, m) {
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
}

function readManifest(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function api(method, path, body, { retried = false } = {}) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${env.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
        await refresh();
        return api(method, path, body, { retried: true });
    }
    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${method} ${path}`);
        err.status = res.status;
        err.body = text;
        throw err;
    }
    if (res.status === 204 || !text) return null;
    try { return JSON.parse(text); }
    catch { return text; }
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
    if (!res.ok) {
        console.error('Token refresh failed:', res.status, await res.text());
        process.exit(1);
    }
    const data = await res.json();
    env.accessToken = data.access_token;
    env.refreshToken = data.refresh_token;
}
