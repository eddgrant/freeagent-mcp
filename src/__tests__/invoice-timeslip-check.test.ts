import { describe, it, expect, vi } from 'vitest';
import {
  deriveImplicatedProjectUrls,
  findUnbilledTimeslipsForProjects,
  formatUnbilledRefusal,
} from '../invoice-timeslip-check.js';

describe('deriveImplicatedProjectUrls', () => {
  it('returns the primary project URL when only `project` is set', () => {
    expect(deriveImplicatedProjectUrls({ project: 'https://api.freeagent.com/v2/projects/100' }))
      .toEqual(['https://api.freeagent.com/v2/projects/100']);
  });

  it('expands numeric project_ids using the primary project URL as a base', () => {
    const urls = deriveImplicatedProjectUrls({
      project: 'https://api.freeagent.com/v2/projects/100',
      projectIds: ['100', '200'],
    });
    expect(urls).toEqual([
      'https://api.freeagent.com/v2/projects/100',
      'https://api.freeagent.com/v2/projects/200',
    ]);
  });

  it('falls back to the prod base URL when no primary URL is available', () => {
    expect(deriveImplicatedProjectUrls({ projectIds: ['200'] }))
      .toEqual(['https://api.freeagent.com/v2/projects/200']);
  });

  it('reuses the host of an existing project URL when expanding IDs (sandbox-friendly)', () => {
    const urls = deriveImplicatedProjectUrls({
      existingProject: 'https://api.sandbox.freeagent.com/v2/projects/100',
      projectIds: ['100', '200'],
    });
    expect(urls).toEqual([
      'https://api.sandbox.freeagent.com/v2/projects/100',
      'https://api.sandbox.freeagent.com/v2/projects/200',
    ]);
  });

  it('includes the existing invoice project for the update flow', () => {
    const urls = deriveImplicatedProjectUrls({
      existingProject: 'https://api.freeagent.com/v2/projects/100',
      projectIds: ['200'],
    });
    expect(urls).toContain('https://api.freeagent.com/v2/projects/100');
    expect(urls).toContain('https://api.freeagent.com/v2/projects/200');
  });

  it('deduplicates when project_ids contains the primary', () => {
    const urls = deriveImplicatedProjectUrls({
      project: 'https://api.freeagent.com/v2/projects/100',
      projectIds: ['100', '200'],
    });
    expect(urls).toHaveLength(2);
  });

  it('returns an empty array when nothing is set', () => {
    expect(deriveImplicatedProjectUrls({})).toEqual([]);
  });
});

describe('findUnbilledTimeslipsForProjects', () => {
  function makeClient(byProject: Record<string, any[]>) {
    return {
      listTimeslips: vi.fn(async ({ project }: { project?: string }) => {
        return project ? (byProject[project] || []) : [];
      }),
    };
  }

  it('queries each project with view=unbilled in parallel and returns only those with results', async () => {
    const client = makeClient({
      'https://api.freeagent.com/v2/projects/100': [
        { url: 'https://api.freeagent.com/v2/timeslips/1', dated_on: '2026-04-01', hours: '1.0' } as any,
      ],
      'https://api.freeagent.com/v2/projects/200': [],
    });
    const result = await findUnbilledTimeslipsForProjects(client as any, [
      'https://api.freeagent.com/v2/projects/100',
      'https://api.freeagent.com/v2/projects/200',
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].projectUrl).toBe('https://api.freeagent.com/v2/projects/100');
    expect(client.listTimeslips).toHaveBeenCalledTimes(2);
    expect(client.listTimeslips).toHaveBeenCalledWith({
      project: 'https://api.freeagent.com/v2/projects/100',
      view: 'unbilled',
    });
    expect(client.listTimeslips).toHaveBeenCalledWith({
      project: 'https://api.freeagent.com/v2/projects/200',
      view: 'unbilled',
    });
  });

  it('issues per-project queries concurrently rather than sequentially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      listTimeslips: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return [];
      }),
    };
    await findUnbilledTimeslipsForProjects(client as any, [
      'https://api.freeagent.com/v2/projects/100',
      'https://api.freeagent.com/v2/projects/200',
      'https://api.freeagent.com/v2/projects/300',
    ]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('returns an empty array when no project has unbilled timeslips', async () => {
    const client = makeClient({});
    const result = await findUnbilledTimeslipsForProjects(client as any, [
      'https://api.freeagent.com/v2/projects/100',
    ]);
    expect(result).toEqual([]);
  });
});

describe('formatUnbilledRefusal', () => {
  const sample = [
    {
      projectUrl: 'https://api.freeagent.com/v2/projects/100',
      timeslips: [
        { url: 'https://api.freeagent.com/v2/timeslips/1', dated_on: '2026-04-01', hours: '1.5' } as any,
        { url: 'https://api.freeagent.com/v2/timeslips/2', dated_on: '2026-04-02', hours: '0.5' } as any,
      ],
    },
  ];

  it('summarises counts, hours, and date range per project', () => {
    const message = formatUnbilledRefusal(sample);
    expect(message).toContain('project 100');
    expect(message).toContain('2 unbilled timeslip(s)');
    expect(message).toContain('2.00 hour(s) total');
    expect(message).toContain('2026-04-01');
    expect(message).toContain('2026-04-02');
  });

  it('mentions both retry options', () => {
    const message = formatUnbilledRefusal(sample);
    expect(message).toContain('include_timeslips');
    expect(message).toContain('omit_unbilled_timeslips: true');
  });

  it('uses singular "on <date>" when all timeslips share a date', () => {
    const message = formatUnbilledRefusal([
      {
        projectUrl: 'https://api.freeagent.com/v2/projects/100',
        timeslips: [
          { url: 'x', dated_on: '2026-04-01', hours: '1.0' } as any,
        ],
      },
    ]);
    expect(message).toContain('on 2026-04-01');
    expect(message).not.toContain('from 2026-04-01 to 2026-04-01');
  });
});
