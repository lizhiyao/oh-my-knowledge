import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('endpoint-rule collectFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-ep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // 跑一次 check,用 stub fetch 截下请求体里的 skill.files。
  async function collect(maxFileBytes?: number): Promise<Record<string, string>> {
    let body: RequestBody | undefined;
    const rule = makeEndpointRule(
      { id: 'x', displayName: 'X', severity: 'warn', endpoint: 'https://x', maxFileBytes },
      stubFetch((_u, init) => {
        body = JSON.parse(init.body as string);
        return { json: () => ({ status: 'pass', message: 'ok' }) };
      }),
    );
    const art: Artifact = { name: 'my-skill', kind: 'skill', source: 'file-path', content: 'c', skillRoot: dir };
    await rule.check(ctx({ artifact: art }));
    return body!.skill.files;
  }

  it('收子文件、排除 SKILL.md/二进制/symlink、按字节截断超限文件', async () => {
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# main');
    writeFileSync(join(dir, 'references/api.md'), 'hello');
    writeFileSync(join(dir, 'blob.dat'), Buffer.from([1, 2, 0, 3, 4])); // 含 NUL → 二进制
    writeFileSync(join(dir, 'big.txt'), '中'.repeat(20));                 // 60 字节,超 maxFileBytes=10
    let symlinked = true;
    try { symlinkSync('/etc/hostname', join(dir, 'link.md')); } catch { symlinked = false; }

    const files = await collect(10);

    assert.equal(files['references/api.md'], 'hello'); // 文本子文件收进
    assert.equal(files['SKILL.md'], undefined);         // 主文件排除
    assert.equal(files['blob.dat'], undefined);         // NUL 二进制跳过
    if (symlinked) assert.equal(files['link.md'], undefined); // symlink 跳过(不外发 root 外内容)
    assert.ok(files['big.txt'].endsWith('\n…[truncated]')); // 超限截断
    const head = files['big.txt'].replace('\n…[truncated]', '');
    // 按字节封顶:容 1 个替换字符(末尾半个 UTF-8 字符 decode 成 U+FFFD,3 字节)的余量。
    // 旧的「按字符 slice」会得到 10 个「中」= 30 字节,远超此界 → 能抓住回退。
    assert.ok(Buffer.byteLength(head, 'utf-8') <= 13);
  });
});
