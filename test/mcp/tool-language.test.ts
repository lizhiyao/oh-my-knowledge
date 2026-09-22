/**
 * MCP 展示元数据的语言一致性。
 *
 * `title` 与 `description` 会直接显示在宿主界面与 Agent 的工具清单里；此前 title 恒为
 * 中文、description 恒为英文，英文用户拿到的是混排。这里按真实 `tools/list` 与
 * `resources/list` 判：同一语言内两者不得混排，且两版都要完整非空。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'vitest';
import { createObservationMcpServer } from '../../src/mcp/mcp-server.js';
import type { Lang } from '../../src/shared/language.js';

const HAN = /[一-鿿]/u;

async function advertised(lang: Lang): Promise<{
  tools: { name: string; title?: string; description?: string }[];
  resources: { title?: string; description?: string }[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-lang-'));
  const server = createObservationMcpServer({ observationsDir: dir, lang });
  const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    }));
    const resources = (await client.listResources()).resources.map((resource) => ({
      title: resource.title,
      description: resource.description,
    }));
    return { tools, resources };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP 展示元数据按语言一致', () => {
  it('中文版：title 与 description 都是中文；英文版都不得含中文', async () => {
    const zh = await advertised('zh');
    const en = await advertised('en');
    assert.ok(zh.tools.length >= 5, 'expected the observation tool surface to be advertised');
    for (const [label, items] of [['zh', zh.tools], ['en', en.tools]] as const) {
      for (const tool of items) {
        assert.ok(tool.title && tool.title.length > 0, `${label}: ${tool.name} has no title`);
        assert.ok(tool.description && tool.description.length > 0, `${label}: ${tool.name} has no description`);
        const titleIsHan = HAN.test(tool.title);
        assert.equal(titleIsHan, HAN.test(tool.description),
          `${label}: ${tool.name} mixes languages — title "${tool.title}" vs description "${tool.description}"`);
        if (label === 'zh') assert.ok(titleIsHan, `zh: ${tool.name} title lost its Chinese copy`);
        else assert.ok(!titleIsHan, `en: ${tool.name} still carries Chinese copy`);
      }
    }
    assert.equal(zh.tools.length, en.tools.length);
    assert.deepEqual(zh.tools.map((tool) => tool.name), en.tools.map((tool) => tool.name));
  });

  it('复核组件的资源标题与说明同语言', async () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const resource of (await advertised(lang)).resources) {
        assert.ok(resource.title && resource.description, `${lang}: resource metadata is incomplete`);
        assert.equal(HAN.test(resource.title), HAN.test(resource.description),
          `${lang}: ${resource.title} mixes languages`);
      }
    }
  });

  it('缺省按环境推断，不写死中文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mcp-lang-env-'));
    const server = createObservationMcpServer({ observationsDir: dir, env: { LANG: 'en_US.UTF-8' } });
    const client = new Client({ name: 'omk-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      assert.ok(tools.length > 0);
      for (const tool of tools) assert.ok(!HAN.test(tool.title ?? ''), `${tool.name} should be English`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
