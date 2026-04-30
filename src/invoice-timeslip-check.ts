// Detect-and-refuse helpers for invoice creation/update.
//
// Without this check, an LLM agent calling create_invoice without
// `include_timeslips` could create an invoice that ignores existing
// unbilled timeslips on the project(s) — leaving them stranded as
// uninvoiced revenue. We refuse such requests by default and surface a
// clear next-step menu.
//
// The check is bypassed when the caller has made an active choice via
// either `include_timeslips` (yes, attach them like so) or
// `omit_unbilled_timeslips: true` (no, leave them alone).

import type { Timeslip } from './types.js';

export interface TimeslipQuerier {
    listTimeslips(params: {
        project?: string;
        view?: 'all' | 'unbilled' | 'running';
    }): Promise<Timeslip[]>;
}

const PROJECT_URL_PREFIX = 'https://api.freeagent.com/v2/projects';

// Resolve full project URLs from a (possibly mixed) set of inputs.
// `project` and `existingProject` are URLs; `projectIds` are numeric IDs.
export function deriveImplicatedProjectUrls(args: {
    project?: string;
    projectIds?: string[];
    existingProject?: string;
}): string[] {
    const urls = new Set<string>();
    if (args.existingProject) urls.add(args.existingProject);
    if (args.project) urls.add(args.project);

    if (args.projectIds && args.projectIds.length > 0) {
        // Reuse the host/path of `project` (or `existingProject`) so test
        // fixtures with non-prod base URLs still work.
        const sample = args.project || args.existingProject;
        const base = sample
            ? sample.replace(/\/projects\/[^/]+$/, '/projects')
            : PROJECT_URL_PREFIX;
        for (const id of args.projectIds) {
            urls.add(`${base}/${id}`);
        }
    }
    return Array.from(urls);
}

export interface UnbilledByProject {
    projectUrl: string;
    timeslips: Timeslip[];
}

export async function findUnbilledTimeslipsForProjects(
    client: TimeslipQuerier,
    projectUrls: string[],
): Promise<UnbilledByProject[]> {
    const out: UnbilledByProject[] = [];
    for (const projectUrl of projectUrls) {
        const slips = await client.listTimeslips({
            project: projectUrl,
            view: 'unbilled',
        });
        if (slips.length > 0) {
            out.push({ projectUrl, timeslips: slips });
        }
    }
    return out;
}

// Numbering-source refusal message for multi-project invoices.
//
// The singular `invoice.project` field on FreeAgent's API controls which
// project's invoice sequence the new invoice's reference is drawn from
// (or the org-wide sequence when omitted). On a multi-project invoice
// the choice is ambiguous, so we refuse unless the caller has set
// `numbering_source` explicitly. We don't inspect the projects to check
// which ones have per-project sequences — the user knows their own setup,
// and FreeAgent just falls back to org-wide for any picked project that
// doesn't have its own sequence, so no harm done.

export function formatNumberingRefusal(projectIds: string[]): string {
    const lines: string[] = [];
    lines.push('Refusing to create this multi-project invoice — the choice of invoice numbering sequence is ambiguous.');
    lines.push('');
    lines.push('Pick the source for the invoice reference number by setting `numbering_source`:');
    lines.push('');
    for (const id of projectIds) {
        lines.push(`  numbering_source: "${id}"   → draw the invoice number from project ${id}'s per-project sequence (or fall back to the organisation-wide sequence if that project does not have one configured)`);
    }
    lines.push(`  numbering_source: "org-wide"  → explicitly use the organisation-wide invoice sequence, ignoring any project-level sequences`);
    return lines.join('\n');
}

export function formatUnbilledRefusal(unbilled: UnbilledByProject[]): string {
    const lines: string[] = [];
    lines.push('Refusing to create/update this invoice — unbilled timeslips exist on the implicated project(s):');
    lines.push('');
    for (const { projectUrl, timeslips } of unbilled) {
        const id = projectUrl.split('/').pop();
        const totalHours = timeslips.reduce((acc, s) => acc + Number(s.hours || 0), 0);
        const dates = timeslips.map(s => s.dated_on).sort();
        const range = dates.length === 0
            ? ''
            : dates[0] === dates[dates.length - 1]
                ? ` on ${dates[0]}`
                : ` from ${dates[0]} to ${dates[dates.length - 1]}`;
        lines.push(`  - project ${id}: ${timeslips.length} unbilled timeslip(s), ${totalHours.toFixed(2)} hour(s) total${range}`);
    }
    lines.push('');
    lines.push('To bill these timeslips on this invoice, retry with one of:');
    lines.push('  include_timeslips: "billed_grouped_by_timeslip_task"   (one line per task)');
    lines.push('  include_timeslips: "billed_grouped_by_timeslip"        (one line per timeslip)');
    lines.push('  include_timeslips: "billed_grouped_by_timeslip_date"   (one line per date)');
    lines.push('  include_timeslips: "billed_grouped_by_single_timeslip" (a single combined line)');
    lines.push('');
    lines.push('To deliberately leave them unbilled (they will remain available for a future invoice), retry with:');
    lines.push('  omit_unbilled_timeslips: true');
    return lines.join('\n');
}
