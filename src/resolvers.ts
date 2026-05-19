// Shared name → URL resolvers.
//
// FreeAgent endpoints want resource URLs, but people think in names
// ("Travel", "Jane Smith"). These resolvers accept a URL, a numeric ID,
// or a human name and return the canonical resource URL — throwing a
// helpful, candidate-listing error on ambiguity or no match.
//
// Pure-ish: each resolver takes a thin client interface (satisfied by
// FreeAgentClient) so it can be unit-tested with a mock.

import type { CategoriesResponse, Category, Project, User } from './types.js';

const API_BASE = 'https://api.freeagent.com/v2';

// Tokens that mean "the authenticated user" for claimant resolution.
const CURRENT_USER_TOKENS = new Set(['me', 'self', 'current', 'current user', 'current_user']);

export interface CategoryResolverClient {
    listCategories(params?: { sub_accounts?: boolean }): Promise<CategoriesResponse>;
}

export interface UserResolverClient {
    listUsers(params?: { view?: string }): Promise<User[]>;
    getCurrentUser(): Promise<User>;
}

export interface ProjectResolverClient {
    listProjects(params?: { view?: string; sort?: string; contact?: string }): Promise<Project[]>;
}

/** Flatten FreeAgent's grouped categories response into a single list. */
export function flattenCategories(grouped: CategoriesResponse): Category[] {
    return [
        ...(grouped.admin_expenses_categories ?? []),
        ...(grouped.cost_of_sales_categories ?? []),
        ...(grouped.income_categories ?? []),
        ...(grouped.general_categories ?? []),
    ];
}

function isUrl(s: string): boolean {
    return /^https?:\/\//i.test(s);
}

function ambiguous(kind: string, input: string, candidates: string[]): Error {
    return new Error(
        `"${input}" is ambiguous — it matches ${candidates.length} ${kind}s: ` +
        `${candidates.join('; ')}. Pass a more specific value or the ${kind} URL.`,
    );
}

/** Resolve a category reference to its API URL. Accepts a category URL
 *  (passed straight through), a nominal code, or a category name —
 *  matched case-insensitively, exact first, then a unique partial match. */
export async function resolveCategory(
    client: CategoryResolverClient,
    input: string,
): Promise<string> {
    const raw = (input ?? '').trim();
    if (!raw) throw new Error('category is required');
    if (isUrl(raw)) return raw;

    const all = flattenCategories(await client.listCategories());
    const describe = (c: Category) => `${c.description} (code ${c.nominal_code})`;

    // Numeric → nominal code.
    if (/^\d+$/.test(raw)) {
        const byCode = all.filter(c => c.nominal_code === raw);
        if (byCode.length === 1) return byCode[0].url;
        if (byCode.length > 1) throw ambiguous('category', raw, byCode.map(describe));
        throw new Error(`No category found with nominal code "${raw}". Use list_categories to browse.`);
    }

    const needle = raw.toLowerCase();
    const exact = all.filter(c => c.description?.toLowerCase() === needle);
    if (exact.length === 1) return exact[0].url;
    if (exact.length > 1) throw ambiguous('category', raw, exact.map(describe));

    const partial = all.filter(c => c.description?.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0].url;
    if (partial.length > 1) throw ambiguous('category', raw, partial.map(describe));

    throw new Error(
        `No category matches "${raw}". Use list_categories to see what's available, ` +
        `then pass an exact name, a nominal code, or the category URL.`,
    );
}

/** Resolve a claimant reference to a user URL. Accepts a user URL, a
 *  numeric ID, an email address, a full name, or one of the
 *  "current user" tokens ("me", "self", ...). An empty/undefined input
 *  resolves to the authenticated user. */
export async function resolveUser(
    client: UserResolverClient,
    input: string | undefined,
): Promise<string> {
    const raw = (input ?? '').trim();
    if (!raw || CURRENT_USER_TOKENS.has(raw.toLowerCase())) {
        return (await client.getCurrentUser()).url;
    }
    if (isUrl(raw)) return raw;
    if (/^\d+$/.test(raw)) return `${API_BASE}/users/${raw}`;

    const users = await client.listUsers();
    const needle = raw.toLowerCase();
    const label = (u: User) => `${u.first_name} ${u.last_name} <${u.email}>`;

    const byEmail = users.filter(u => u.email?.toLowerCase() === needle);
    if (byEmail.length === 1) return byEmail[0].url;

    const byName = users.filter(
        u => `${u.first_name} ${u.last_name}`.trim().toLowerCase() === needle,
    );
    if (byName.length === 1) return byName[0].url;
    if (byName.length > 1) throw ambiguous('user', raw, byName.map(label));

    const partial = users.filter(u =>
        `${u.first_name} ${u.last_name}`.toLowerCase().includes(needle) ||
        (u.email?.toLowerCase().includes(needle) ?? false),
    );
    if (partial.length === 1) return partial[0].url;
    if (partial.length > 1) throw ambiguous('user', raw, partial.map(label));

    throw new Error(
        `No user matches "${raw}". Use list_users to see the team, then pass a ` +
        `full name, an email address, or the user URL.`,
    );
}

/** Resolve a project reference to its API URL. Accepts a project URL, a
 *  numeric ID, or a project name (exact, then a unique partial match). */
export async function resolveProject(
    client: ProjectResolverClient,
    input: string,
): Promise<string> {
    const raw = (input ?? '').trim();
    if (!raw) throw new Error('project is required');
    if (isUrl(raw)) return raw;
    if (/^\d+$/.test(raw)) return `${API_BASE}/projects/${raw}`;

    const projects = await client.listProjects();
    const needle = raw.toLowerCase();

    const exact = projects.filter(p => p.name?.toLowerCase() === needle);
    if (exact.length === 1) return exact[0].url;
    if (exact.length > 1) throw ambiguous('project', raw, exact.map(p => p.name));

    const partial = projects.filter(p => p.name?.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0].url;
    if (partial.length > 1) throw ambiguous('project', raw, partial.map(p => p.name));

    throw new Error(
        `No project matches "${raw}". Use list_projects to see the projects, ` +
        `then pass a project name or URL.`,
    );
}
