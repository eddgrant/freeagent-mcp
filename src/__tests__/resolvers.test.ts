// Unit tests for the shared name → URL resolvers.

import { describe, it, expect } from 'vitest';
import { resolveCategory, resolveUser, resolveProject, flattenCategories } from '../resolvers.js';
import type { CategoriesResponse, Category, Project, User } from '../types.js';

function cat(partial: Partial<Category>): Category {
  return {
    url: 'https://api.freeagent.com/v2/categories/000',
    description: 'Category',
    nominal_code: '000',
    ...partial,
  };
}

function grouped(admin: Category[], general: Category[] = []): CategoriesResponse {
  return {
    admin_expenses_categories: admin,
    cost_of_sales_categories: [],
    income_categories: [],
    general_categories: general,
  };
}

function user(partial: Partial<User>): User {
  return {
    url: 'https://api.freeagent.com/v2/users/0',
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    role: 'Owner',
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

const travel = cat({ url: 'https://api.freeagent.com/v2/categories/285', description: 'Travel', nominal_code: '285' });
const subsistence = cat({ url: 'https://api.freeagent.com/v2/categories/286', description: 'Subsistence', nominal_code: '286' });
const travelEU = cat({ url: 'https://api.freeagent.com/v2/categories/287', description: 'Travel — Europe', nominal_code: '287' });

describe('flattenCategories', () => {
  it('combines all four category groups into one list', () => {
    const flat = flattenCategories(grouped([travel], [subsistence]));
    expect(flat).toHaveLength(2);
    expect(flat.map(c => c.description)).toEqual(['Travel', 'Subsistence']);
  });

  it('tolerates missing groups', () => {
    expect(flattenCategories({} as CategoriesResponse)).toEqual([]);
  });
});

describe('resolveCategory', () => {
  const client = (cats: Category[]) => ({ listCategories: async () => grouped(cats) });

  it('passes a category URL straight through without an API call', async () => {
    let called = false;
    const c = { listCategories: async () => { called = true; return grouped([]); } };
    const url = await resolveCategory(c, 'https://api.freeagent.com/v2/categories/285');
    expect(url).toBe('https://api.freeagent.com/v2/categories/285');
    expect(called).toBe(false);
  });

  it('resolves a numeric nominal code', async () => {
    expect(await resolveCategory(client([travel, subsistence]), '286')).toBe(subsistence.url);
  });

  it('resolves an exact name case-insensitively', async () => {
    expect(await resolveCategory(client([travel, subsistence]), 'travel')).toBe(travel.url);
  });

  it('resolves a unique partial match', async () => {
    expect(await resolveCategory(client([travel, subsistence]), 'subsist')).toBe(subsistence.url);
  });

  it('prefers an exact match over partial matches', async () => {
    // "Travel" is an exact match even though "Travel — Europe" also contains it.
    expect(await resolveCategory(client([travel, travelEU]), 'Travel')).toBe(travel.url);
  });

  it('throws a candidate-listing error on an ambiguous partial match', async () => {
    await expect(resolveCategory(client([travel, travelEU]), 'trav'))
      .rejects.toThrow(/ambiguous.*Travel.*Travel — Europe/s);
  });

  it('throws when no category matches', async () => {
    await expect(resolveCategory(client([travel]), 'Wining and dining'))
      .rejects.toThrow(/No category matches/);
  });

  it('throws when an unknown nominal code is given', async () => {
    await expect(resolveCategory(client([travel]), '999'))
      .rejects.toThrow(/No category found with nominal code/);
  });

  it('throws when the input is empty', async () => {
    await expect(resolveCategory(client([travel]), '   ')).rejects.toThrow(/category is required/);
  });
});

describe('resolveUser', () => {
  const jane = user({ url: 'https://api.freeagent.com/v2/users/1', first_name: 'Jane', last_name: 'Smith', email: 'jane@co.com' });
  const john = user({ url: 'https://api.freeagent.com/v2/users/2', first_name: 'John', last_name: 'Smith', email: 'john@co.com' });
  const me = user({ url: 'https://api.freeagent.com/v2/users/9', first_name: 'Me', last_name: 'Myself', email: 'me@co.com' });

  const client = (users: User[]) => ({
    listUsers: async () => users,
    getCurrentUser: async () => me,
  });

  it('resolves an empty/undefined claimant to the current user', async () => {
    expect(await resolveUser(client([jane, john]), undefined)).toBe(me.url);
    expect(await resolveUser(client([jane, john]), '')).toBe(me.url);
  });

  it('resolves the "me" token to the current user', async () => {
    expect(await resolveUser(client([jane, john]), 'me')).toBe(me.url);
    expect(await resolveUser(client([jane, john]), 'Current User')).toBe(me.url);
  });

  it('passes a user URL straight through', async () => {
    expect(await resolveUser(client([]), 'https://api.freeagent.com/v2/users/42'))
      .toBe('https://api.freeagent.com/v2/users/42');
  });

  it('builds a URL from a numeric id', async () => {
    expect(await resolveUser(client([]), '42')).toBe('https://api.freeagent.com/v2/users/42');
  });

  it('resolves an exact email address', async () => {
    expect(await resolveUser(client([jane, john]), 'JANE@co.com')).toBe(jane.url);
  });

  it('resolves a full name', async () => {
    expect(await resolveUser(client([jane, john]), 'jane smith')).toBe(jane.url);
  });

  it('throws a candidate-listing error when a name is ambiguous', async () => {
    await expect(resolveUser(client([jane, john]), 'Smith'))
      .rejects.toThrow(/ambiguous.*Jane Smith.*John Smith/s);
  });

  it('throws when no user matches', async () => {
    await expect(resolveUser(client([jane, john]), 'Nobody Here'))
      .rejects.toThrow(/No user matches/);
  });
});

describe('resolveProject', () => {
  function proj(partial: Partial<Project>): Project {
    return {
      url: 'https://api.freeagent.com/v2/projects/0',
      name: 'Project',
      contact: '',
      status: 'Active',
      budget: 0,
      budget_units: 'Hours',
      currency: 'GBP',
      uses_project_invoice_sequence: false,
      created_at: '',
      updated_at: '',
      ...partial,
    };
  }

  const acme = proj({ url: 'https://api.freeagent.com/v2/projects/9', name: 'Acme Rebuild' });
  const acmePhase2 = proj({ url: 'https://api.freeagent.com/v2/projects/10', name: 'Acme Phase 2' });
  const client = (projects: Project[]) => ({ listProjects: async () => projects });

  it('passes a project URL straight through', async () => {
    expect(await resolveProject(client([]), 'https://api.freeagent.com/v2/projects/42'))
      .toBe('https://api.freeagent.com/v2/projects/42');
  });

  it('builds a URL from a numeric id', async () => {
    expect(await resolveProject(client([]), '42')).toBe('https://api.freeagent.com/v2/projects/42');
  });

  it('resolves an exact project name case-insensitively', async () => {
    expect(await resolveProject(client([acme, acmePhase2]), 'acme rebuild')).toBe(acme.url);
  });

  it('resolves a unique partial match', async () => {
    expect(await resolveProject(client([acme, acmePhase2]), 'Phase 2')).toBe(acmePhase2.url);
  });

  it('throws on an ambiguous partial match', async () => {
    await expect(resolveProject(client([acme, acmePhase2]), 'Acme'))
      .rejects.toThrow(/ambiguous/);
  });

  it('throws when no project matches', async () => {
    await expect(resolveProject(client([acme]), 'Unknown')).rejects.toThrow(/No project matches/);
  });
});
