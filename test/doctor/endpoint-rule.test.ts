import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEndpointRule } from '../../src/doctor/endpoint-rule.js';
import type { DoctorContext } from '../../src/doctor/contracts.js';
import type { Artifact } from '../../src/artifacts/contracts.js';

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
  handler: (url: string, init: RequestInit) => {
    ok?: boolean; status?: number; headers?: Record<string, string>; json: () => unknown;
  } | Promise<never>,
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const r = await handler(url, init);
    const headers = r.headers ?? {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
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

  it('truncates oversized message/hint and replaces oversized detail in valid responses', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'warn', endpoint: 'https://x/audit' },
      stubFetch(() => ({
        json: () => ({
          status: 'warn',
          message: 'm'.repeat(5000),
          hint: 'h'.repeat(5000),
          detail: { blob: 'd'.repeat(5000) },
        }),
      })),
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'warn');
    // message = displayName 前缀 + 2000 字符 + 截断标记,远小于 5000。
    assert.ok(out.message.length < 2100);
    assert.ok(out.message.endsWith('…[truncated]'));
    assert.ok(out.hint!.length <= 2000 + '…[truncated]'.length);
    assert.ok(out.hint!.endsWith('…[truncated]'));
    // detail 超限 → 替换成 { truncated, preview } 结构,仍是合法 JSON 值。
    assert.equal(out.detail!.truncated, true);
    assert.equal(typeof out.detail!.preview, 'string');
    assert.equal((out.detail!.preview as string).length, 2000);
  });

  it('keeps short message/hint/detail untouched', async () => {
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'warn', endpoint: 'https://x/audit' },
      stubFetch(() => ({ json: () => ({ status: 'pass', message: 'ok', hint: 'fine', detail: { n: 1 } }) })),
    );
    const out = await rule.check(ctx());
    assert.equal(out.message, '审查: ok');
    assert.equal(out.hint, 'fine');
    assert.deepEqual(out.detail, { n: 1 });
  });
});

describe('endpoint-rule URL / SSRF 校验', () => {
  /** fetch stub:记录是否被调用,默认返回 pass。 */
  function trackingFetch(): { fetchFn: typeof fetch; called: () => boolean } {
    let called = false;
    const fetchFn = stubFetch(() => {
      called = true;
      return { json: () => ({ status: 'pass', message: 'ok' }) };
    });
    return { fetchFn, called: () => called };
  }

  it('fails on unparsable endpoint URL without sending a request', async () => {
    const { fetchFn, called } = trackingFetch();
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'not a url' },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /不是合法 URL/);
    assert.equal(called(), false);
  });

  it('fails on non-http(s) scheme without sending a request', async () => {
    const { fetchFn, called } = trackingFetch();
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'file:///etc/passwd' },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /http\/https/);
    assert.equal(called(), false);
  });

  const privateEndpoints = [
    'http://169.254.169.254/latest/meta-data', // 云 metadata
    'http://127.0.0.1:8080/audit',
    'http://localhost:3000/audit',
    'http://[::1]:3000/audit',
    'http://10.1.2.3/audit',
    'http://172.16.0.1/audit',
    'http://172.31.255.255/audit',
    'http://192.168.1.1/audit',
    'http://foo.local/audit',
    // 字面绕过形态(WHATWG 规范化后):
    'http://0/audit',                          // → 0.0.0.0
    'http://0.0.0.0/audit',                    // 0.0.0.0/8
    'http://localhost./audit',                 // FQDN 尾点
    'http://foo.local./audit',                 // FQDN 尾点 + .local
    'http://[::ffff:127.0.0.1]/audit',         // IPv4-mapped(规范成 ::ffff:7f00:1)
    'http://[::ffff:169.254.169.254]/audit',   // IPv4-mapped metadata
    'http://[::]/audit',                       // IPv6 unspecified
    'http://[fc00::1]/audit',                  // ULA fc00::/7
    'http://[fe80::1]/audit',                  // link-local fe80::/10
  ];

  for (const endpoint of privateEndpoints) {
    it(`refuses private/loopback endpoint by default: ${endpoint}`, async () => {
      const { fetchFn, called } = trackingFetch();
      const rule = makeEndpointRule(
        { id: 'sec', displayName: '审查', severity: 'fatal', endpoint },
        fetchFn,
      );
      const out = await rule.check(ctx());
      assert.equal(out.status, 'fail');
      assert.match(out.message, /私网|SSRF/);
      assert.match(out.message, /allowPrivateHost/); // 提示放行开关
      assert.equal(called(), false);                 // 拒绝发生在请求组装前
    });
  }

  it('allows private endpoint when allowPrivateHost=true', async () => {
    const { fetchFn, called } = trackingFetch();
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'http://127.0.0.1:8080/audit', allowPrivateHost: true },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'pass');
    assert.equal(called(), true);
  });

  it('allows public hosts (172.32.x is outside 172.16.0.0/12)', async () => {
    const { fetchFn, called } = trackingFetch();
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'http://172.32.0.1/audit' },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'pass');
    assert.equal(called(), true);
  });

  it('refuses 3xx redirect (公网 302 → 私网 不被跟随)', async () => {
    let sawRedirectOpt = false;
    const fetchFn = stubFetch((_url, init) => {
      // 校验 check() 关掉了自动跟随重定向。
      sawRedirectOpt = init.redirect === 'manual';
      return { ok: false, status: 302, headers: { location: 'http://169.254.169.254/' }, json: () => ({}) };
    });
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'https://trusted.example.com/audit' },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /重定向|redirect|SSRF/);
    assert.equal(sawRedirectOpt, true);
    assert.equal((out.detail as { location?: string }).location, 'http://169.254.169.254/');
  });

  it('refuses oversized response by Content-Length', async () => {
    const fetchFn = stubFetch(() => ({
      headers: { 'content-length': String(8 * 1024 * 1024) },
      json: () => ({ status: 'pass', message: 'ok' }),
    }));
    const rule = makeEndpointRule(
      { id: 'sec', displayName: '审查', severity: 'fatal', endpoint: 'https://x/audit' },
      fetchFn,
    );
    const out = await rule.check(ctx());
    assert.equal(out.status, 'fail');
    assert.match(out.message, /过大|too large/);
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

  it('大文件只读前缀:截断结果 = 前 maxFileBytes 字节 + 标记(不整文件读入)', async () => {
    // 16 字节 ASCII,maxFileBytes=10 → st.size > maxFileBytes 走 openSync/readSync 前缀路径。
    writeFileSync(join(dir, 'long.txt'), 'abcdefghijklmnop');
    const files = await collect(10);
    assert.equal(files['long.txt'], 'abcdefghij\n…[truncated]');
  });

  it('大文件前缀含 NUL → 按二进制跳过(嗅探在前缀上做)', async () => {
    const buf = Buffer.from('ab\0defghijklmnop'); // NUL 在前 10 字节内,总长超 maxFileBytes=10
    writeFileSync(join(dir, 'bin-head.dat'), buf);
    const files = await collect(10);
    assert.equal(files['bin-head.dat'], undefined);
  });
});
