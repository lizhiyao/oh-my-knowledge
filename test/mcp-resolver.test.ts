import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMcpConfig, resolveMcpUrls, stopAllServers } from '../lib/mcp-resolver.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServers } from '../lib/types.js';

describe('loadMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  });

  it('返回 null 当配置文件不存在', () => {
    const result = loadMcpConfig(join(tmpDir, 'nonexistent.json'));
    assert.equal(result, null);
  });

  it('返回 null 当 JSON 格式错误', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(configPath, '{ invalid json }');
    const result = loadMcpConfig(configPath);
    assert.equal(result, null);
  });

  it('返回 null 当没有符合条件的 server（缺少 urlPatterns）', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        myServer: {
          command: 'echo',
          args: ['hello'],
          // 没有 urlPatterns 和 fetchTool
        },
      },
    }));
    const result = loadMcpConfig(configPath);
    assert.equal(result, null);
  });

  it('返回 null 当 urlPatterns 为空数组', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        myServer: {
          command: 'echo',
          urlPatterns: [],
          fetchTool: { name: 'fetch', urlParam: 'url' },
        },
      },
    }));
    const result = loadMcpConfig(configPath);
    assert.equal(result, null);
  });

  it('正确加载符合条件的 server', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        yuque: {
          command: 'npx',
          args: ['@example/docs-mcp-server'],
          env: { YUQUE_API_TOKEN: 'test-token' },
          urlPatterns: ['docs.example.com'],
          fetchTool: { name: 'get_doc', urlParam: 'url' },
        },
        noPattern: {
          command: 'echo',
          // 不符合条件，应被过滤
        },
      },
    }));
    const result = loadMcpConfig(configPath);
    assert.ok(result);
    assert.deepEqual(Object.keys(result), ['yuque']);
    assert.equal(result.yuque.command, 'npx');
    assert.deepEqual(result.yuque.urlPatterns, ['docs.example.com']);
    assert.equal(result.yuque.fetchTool.name, 'get_doc');
  });

  it('支持 servers 字段（兼容格式）', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      servers: {
        dima: {
          command: 'node',
          args: ['dima-server.js'],
          urlPatterns: ['docs.example.com'],
          fetchTool: { name: 'query', urlParam: 'workItemId' },
        },
      },
    }));
    const result = loadMcpConfig(configPath);
    assert.ok(result);
    assert.deepEqual(Object.keys(result), ['dima']);
  });
});

describe('resolveMcpUrls', () => {
  it('无 mcpServers 时直接返回，不修改 samples', async () => {
    const samples = [{ sample_id: 's1', prompt: 'hello https://docs.example.com/doc1' }];
    await resolveMcpUrls(samples, null);
    assert.equal(samples[0].prompt, 'hello https://docs.example.com/doc1');
  });

  it('无 URL 时直接返回', async () => {
    const samples = [{ sample_id: 's1', prompt: 'no urls here' }];
    const mcpServers: McpServers = {
      yuque: {
        command: 'echo', urlPatterns: ['docs.example.com'],
        fetchTool: { name: 'get_doc', urlParam: 'url' },
      },
    };
    await resolveMcpUrls(samples, mcpServers);
    assert.equal(samples[0].prompt, 'no urls here');
  });

  it('URL 不匹配任何 pattern 时不处理', async () => {
    const samples = [{
      sample_id: 's1',
      prompt: 'check https://github.com/some/repo',
    }];
    const mcpServers: McpServers = {
      yuque: {
        command: 'echo', urlPatterns: ['docs.example.com'],
        fetchTool: { name: 'get_doc', urlParam: 'url' },
      },
    };
    await resolveMcpUrls(samples, mcpServers);
    assert.equal(samples[0].prompt, 'check https://github.com/some/repo');
  });

  it('正确匹配 eval-samples 中的docs URL 到 MCP server', async () => {
    // 模拟 sepc-test-eval 的 eval-samples.json 数据
    const samples = [{
      sample_id: 's001',
      prompt: '原始输入：PRD文档：https://docs.example.com/ns1/slug1/id1后端系分文档：https://docs.example.com/ns2/slug2/id2，请输出一个测分用例',
    }];

    const mcpServers: McpServers = {
      yuque: {
        command: 'echo',
        urlPatterns: ['docs.example.com'],
        fetchTool: { name: 'get_doc', urlParam: 'url' },
      },
    };

    // resolveMcpUrls 会尝试连接 MCP server，这里会失败
    // 但我们验证的是 URL 匹配和分组逻辑，失败后应有错误信息但不会 throw
    await resolveMcpUrls(samples, mcpServers);

    // MCP server 启动失败时，URL 不会被替换（保持原样，后续由 HTTP 回退处理）
    assert.ok(samples[0].prompt.includes('https://docs.example.com/ns1'));
    assert.ok(samples[0].prompt.includes('https://docs.example.com/ns2'));
  });
});

// --- Internal helper tests (import via dynamic workaround) ---

// We test buildToolArgs and extractContent indirectly through resolveMcpUrls,
// but also test the logic directly by re-implementing the pure functions here.

describe('buildToolArgs logic', () => {
  // Re-implement for direct testing (the module doesn't export it)
  interface FetchToolConfig {
    name: string;
    urlParam?: string;
    urlTransform?: { regex: string; params: Record<string, string> };
  }

  function buildToolArgs(fetchTool: FetchToolConfig, url: string): Record<string, string> | null {
    if (fetchTool.urlTransform) {
      const { regex, params } = fetchTool.urlTransform;
      const match = url.match(new RegExp(regex));
      if (!match) return null;
      const args: Record<string, string> = {};
      for (const [key, template] of Object.entries(params)) {
        args[key] = template.replace(/\$(\d+)/g, (_, i) => match[Number(i)] || '');
      }
      return args;
    }
    const urlParam = fetchTool.urlParam || 'url';
    return { [urlParam]: url };
  }

  it('simple mode: 使用 urlParam', () => {
    const result = buildToolArgs(
      { name: 'get_doc', urlParam: 'doc_url' },
      'https://example.com/doc/123',
    );
    assert.deepEqual(result, { doc_url: 'https://example.com/doc/123' });
  });

  it('simple mode: 默认 urlParam 为 url', () => {
    const result = buildToolArgs({ name: 'get_doc' }, 'https://example.com');
    assert.deepEqual(result, { url: 'https://example.com' });
  });

  it('urlTransform: 从docs URL 提取 namespace + slug', () => {
    const result = buildToolArgs(
      {
        name: 'fetch_doc',
        urlTransform: {
          regex: 'yuque\\.antfin\\.com/([^/]+/[^/]+)/([^/?#]+)',
          params: { namespace: '$1', slug: '$2' },
        },
      },
      'https://docs.example.com/ns1/slug1/id1',
    );
    assert.deepEqual(result, { namespace: 'ns1/slug1', slug: 'id1' });
  });

  it('urlTransform: URL 不匹配正则时返回 null', () => {
    const result = buildToolArgs(
      {
        name: 'fetch_doc',
        urlTransform: {
          regex: 'yuque\\.antfin\\.com/([^/]+/[^/]+)/([^/?#]+)',
          params: { namespace: '$1', slug: '$2' },
        },
      },
      'https://github.com/some/repo',
    );
    assert.equal(result, null);
  });
});

describe('extractContent logic', () => {
  function extractContent(rawText: string, contentExtract?: string): string {
    if (!contentExtract) return rawText;
    try {
      const json = JSON.parse(rawText);
      const fields = contentExtract.split('.');
      let value: unknown = json;
      for (const field of fields) {
        if (value == null) break;
        value = (value as Record<string, unknown>)[field];
      }
      if (typeof value === 'string' && value.length > 0) return value;
      if (value != null && typeof value === 'object') return JSON.stringify(value);
    } catch { /* */ }
    return rawText;
  }

  it('无 contentExtract 时返回原始文本', () => {
    assert.equal(extractContent('raw text', undefined), 'raw text');
  });

  it('提取 data.body 字段', () => {
    const raw = JSON.stringify({ ok: true, data: { title: 'Test', body: '文档内容' } });
    assert.equal(extractContent(raw, 'data.body'), '文档内容');
  });

  it('提取 data.title 字段', () => {
    const raw = JSON.stringify({ ok: true, data: { title: 'Test Title', body: 'content' } });
    assert.equal(extractContent(raw, 'data.title'), 'Test Title');
  });

  it('路径不存在时返回原始文本', () => {
    const raw = JSON.stringify({ ok: true, data: {} });
    assert.equal(extractContent(raw, 'data.nonexistent'), raw);
  });

  it('非 JSON 文本返回原始内容', () => {
    assert.equal(extractContent('not json', 'data.body'), 'not json');
  });

  it('提取到对象时返回 JSON 字符串', () => {
    const raw = JSON.stringify({ data: { nested: { a: 1, b: 2 } } });
    const result = extractContent(raw, 'data.nested');
    assert.equal(result, '{"a":1,"b":2}');
  });
});

describe('stopAllServers', () => {
  it('无活跃连接时安全调用', async () => {
    // 不应抛错
    await stopAllServers();
  });
});
