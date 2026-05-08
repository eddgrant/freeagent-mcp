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

import type { Project, Timeslip } from './types.js';

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

// Issues one query per implicated project, in parallel. We deliberately
// avoid a single org-wide `view: 'unbilled'` fetch: it would pull slips
// from unrelated projects (wasteful at scale) and force the client to
// chase many more pages than necessary on busy orgs. Scoping per project
// keeps the volume bounded and the page count low.
export async function findUnbilledTimeslipsForProjects(
    client: TimeslipQuerier,
    projectUrls: string[],
): Promise<UnbilledByProject[]> {
    const responses = await Promise.all(
        projectUrls.map(projectUrl =>
            client.listTimeslips({ project: projectUrl, view: 'unbilled' })
                .then(timeslips => ({ projectUrl, timeslips })),
        ),
    );
    return responses.filter(r => r.timeslips.length > 0);
}

// Numbering-source refusal helpers for multi-project invoices.
//
// The singular `invoice.project` field on FreeAgent's API controls which
// project's invoice sequence the new invoice's reference is drawn from
// — or the org-wide sequence when omitted. On a multi-project invoice
// the choice is ambiguous, and FreeAgent will silently fall back to the
// org-wide sequence if the user picks a project that has no per-project
// sequence configured. Both behaviours are surprising, so we inspect each
// implicated project up front and refuse with an informative menu.

export interface ProjectQuerier {
    getProject(id: string): Promise<Project>;
}

export interface NumberingCandidate {
    id: string;
    name: string;
    usesProjectInvoiceSequence: boolean;
}

export async function inspectProjectsForNumbering(
    client: ProjectQuerier,
    projectIds: string[],
): Promise<NumberingCandidate[]> {
    const projects = await Promise.all(projectIds.map(id => client.getProject(id)));
    return projects.map((project, i) => ({
        id: projectIds[i],
        name: project.name,
        usesProjectInvoiceSequence: project.uses_project_invoice_sequence === true,
    }));
}

export function formatNumberingRefusal(candidates: NumberingCandidate[]): string {
    const eligible = candidates.filter(c => c.usesProjectInvoiceSequence);
    const ineligible = candidates.filter(c => !c.usesProjectInvoiceSequence);
    const lines: string[] = [];
    lines.push('Refusing to create this multi-project invoice — the choice of invoice numbering sequence must be made explicitly.');
    lines.push('');
    lines.push('Pick a `numbering_source`:');
    lines.push('');
    for (const c of eligible) {
        lines.push(`  numbering_source: "${c.id}"   → use project ${c.id} (${c.name})'s per-project invoice sequence`);
    }
    lines.push(`  numbering_source: "org-wide"  → use the organisation-wide invoice sequence`);
    if (ineligible.length > 0) {
        lines.push('');
        lines.push('These projects on the invoice do NOT have a per-project invoice sequence configured and cannot be used as numbering sources. Their timeslips will still be invoiced normally:');
        for (const c of ineligible) {
            lines.push(`  - project ${c.id} (${c.name})`);
        }
    }
    return lines.join('\n');
}

// Caller picked a specific project as numbering_source, but that project
// has no per-project sequence configured. FreeAgent would silently fall
// back to org-wide; we refuse instead so the surprise is surfaced.
export function formatNumberingPickIneligible(
    picked: NumberingCandidate,
    candidates: NumberingCandidate[],
): string {
    const otherEligible = candidates.filter(c => c.id !== picked.id && c.usesProjectInvoiceSequence);
    const lines: string[] = [];
    lines.push(`Refusing to create this invoice — you set \`numbering_source: "${picked.id}"\` but project ${picked.id} (${picked.name}) does not have a per-project invoice sequence configured in FreeAgent.`);
    lines.push('');
    lines.push('If we proceeded, FreeAgent would silently fall back to the organisation-wide sequence for this invoice, which is probably not what you intended.');
    lines.push('');
    lines.push('Choose one of:');
    for (const c of otherEligible) {
        lines.push(`  numbering_source: "${c.id}"   → use project ${c.id} (${c.name})'s per-project sequence instead`);
    }
    lines.push(`  numbering_source: "org-wide"  → explicitly use the organisation-wide invoice sequence`);
    lines.push(`  Or configure project ${picked.id} to use a per-project invoice sequence in FreeAgent, then retry.`);
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
