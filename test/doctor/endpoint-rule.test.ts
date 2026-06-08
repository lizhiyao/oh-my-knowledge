import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { makeEndpointRule } from '../../src/doctor/endpoint-rule.js';
import type { DoctorContext } from '../../src/types/doctor.js';
import type { Artifact } from '../../src/types/eval.js';

const artifact: Artifact = {
  name: 'my-skill',
  kind: 'skill',
  source: 'file-path',
  content: 'do the thing safely',
  ref: 'abc1234',
};

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    artifact,
    executorName: 'claude',
    model: 'sonnet',
    cwd: '/tmp',
    lang: 'zh',
    timeoutMs: 5000,
    ...overrides,
  };
}

interface RequestBody {
  dimensionId: string;
  params: Record<string, unknown>;
  skill: { name: string; content: string; skillRoot: string | null; ref: string | null; files: Record<string, string> };
}

/** 造一个最小 fetch stub:断言请求、返回指定响应。 */
function stubFetch(
  handler: (url: string, init: RequestInit) => { ok?: boolean; status?: number; json: () => unknown } | Promise<never>,
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const r = await handler(url, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json(),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('endpoint-rule', () => {
  it('POSTs skill snapshot and maps pass response', async () => {
    let seenBody: RequestBody | undefined;
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '安全审查', severity: 'fatal', endpoint: 'https://x/audit', params: { env: 'prod' } },
      stubFetch((_url, init) => {
        seenBody = JSON.parse(init.body as string);
        return { json: () => ({ status: 'pass', message: '无风险' }) };
      }),
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'pass');
    assert.match(out.message, /安全审查: 无风险/);
    // 请求协议
    assert.ok(seenBody);
    assert.equal(seenBody.dimensionId, 'sec');
    assert.deepEqual(seenBody.params, { env: 'prod' });
    assert.equal(seenBody.skill.name, 'my-skill');
    assert.equal(seenBody.skill.content, 'do the thing safely');
    assert.equal(seenBody.skill.ref, 'abc1234');
  });

  it('maps fail response with hint and detail', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '安全审查', severity: 'fatal', endpoint: 'https://x/audit' },
      stubFetch(() => ({ json: () => ({ status: 'fail', message: '发现高危', hint: '改 line 12', detail: { n: 2 } }) })),
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.equal(out.hint, '改 line 12');
    assert.deepEqual(out.detail, { n: 2 });
  });

  it('fails on non-2xx HTTP', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'https://x/audit' },
      stubFetch(() => ({ ok: false, status: 503, json: () => ({}) })),
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /HTTP 503/);
  });

  it('fails when response violates protocol', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'https://x/audit' },
      stubFetch(() => ({ json: () => ({ verdict: 'ok' }) })),
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /status|message/);
  });

  it('fails on network error', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'https://x/audit' },
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /ECONNREFUSED/);
  });

  it('omits files when includeFiles=false', async () => {
    let seenBody: RequestBody | undefined;
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'warn', endpoint: 'https://x/audit', includeFiles: false },
      stubFetch((_url, init) => {
        seenBody = JSON.parse(init.body as string);
        return { json: () => ({ status: 'pass', message: 'ok' }) };
      }),
    );
    await rule.check(ctx());
    assert.ok(seenBody);
    assert.deepEqual(seenBody.skill.files, {});
  });

  it('marks rule as external (online check)', () => {
    const rule = makeEndpointRule({ id: 'sec', displayName: '审查', severity: 'warn', endpoint: 'https://x' });
    assert.equal(rule.external, true);
  });
});
