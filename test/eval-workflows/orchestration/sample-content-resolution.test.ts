import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SampleContentResolutionError,
  hasResolvableSampleUrls,
  isPlaceholderSampleUrl,
  resolveSampleContents,
  type SampleContentResolverSession,
} from '../../../src/eval-workflows/orchestration/index.js';
import {
  createNodeSampleContentResolver,
  loadNodeSampleContentMcpServers,
} from '../../../src/eval-workflows/hosts/input-resolution/node-sample-content-resolver.js';
import type { Sample } from '../../../src/eval-workflows/inputs/contracts/sample.js';
import { isPublicNetworkAddress } from '../../../src/eval-workflows/hosts/input-resolution/safe-http-content-resolver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omk-sample-content-'));
  roots.push(root);
  const path = join(root, '.mcp.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

function session(
  resolve: SampleContentResolverSession['resolve'],
): SampleContentResolverSession & { close: ReturnType<typeof vi.fn> } {
  return { resolve, close: vi.fn(async () => undefined) };
}

describe('resolveSampleContents', () => {
  it('resolves each canonical URL once, replaces every occurrence, and leaves sources immutable', async () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'Read https://docs.acme.dev/a and again https://docs.acme.dev/a.',
      context: 'Mirror: https://docs.acme.dev/a#section',
    }, {
      sample_id: 's2',
      prompt: 'Also https://docs.acme.dev/a',
    }];
    const resolve = vi.fn(async () => ({
      content: '\uFEFFLine 1\r\nLine 2\n',
      mediaType: 'text/plain',
      transportKind: 'mcp' as const,
      classification: 'sensitive' as const,
    }));

    const result = await resolveSampleContents(samples, session(resolve));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('https://docs.acme.dev/a');
    expect(result.samples[0]?.prompt.match(/--- OMK resolved content ---/g)).toHaveLength(2);
    expect(result.samples[0]?.context).toContain('Line 1\nLine 2');
    expect(result.samples[1]?.prompt).toContain('Line 1\nLine 2');
    expect(samples[0]?.prompt).not.toContain('OMK resolved content');
    expect(result.contents).toEqual([
      expect.objectContaining({
        transportKind: 'mcp',
        sampleIds: ['s1', 's2'],
        fields: ['context', 'prompt'],
        sourceUrlDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('does not recursively rewrite URLs found inside already resolved content', async () => {
    const result = await resolveSampleContents([{
      sample_id: 's1',
      prompt: 'Read https://a.acme.dev/doc and https://b.acme.dev/doc.',
    }], session(async (url) => ({
      content: url.includes('a.acme.dev')
        ? 'A references https://b.acme.dev/doc without embedding it.'
        : 'B authoritative content.',
      mediaType: 'text/plain',
      transportKind: 'http',
      classification: 'public',
    })));

    expect(result.samples[0]?.prompt.match(/B authoritative content\./g)).toHaveLength(1);
    expect(result.samples[0]?.prompt).toContain(
      'A references https://b.acme.dev/doc without embedding it.',
    );
  });

  it('bounds repeated inline expansion rather than only unique fetched bytes', async () => {
    const repeated = Array.from({ length: 9 }, () => 'https://docs.acme.dev/large').join(' ');
    await expect(resolveSampleContents([{
      sample_id: 's1',
      prompt: repeated,
    }], session(async () => ({
      content: 'x'.repeat(1024 * 1024),
      mediaType: 'text/plain',
      transportKind: 'http',
      classification: 'public',
    })))).rejects.toThrow(/内联后的外部解析内容总量/);
  });

  it('orders unique resolution calls deterministically', async () => {
    const calls: string[] = [];
    await resolveSampleContents([{
      sample_id: 's1',
      prompt: 'https://z.acme.dev/doc https://a.acme.dev/doc',
    }], session(async (url) => {
      calls.push(url);
      return {
        content: url,
        mediaType: 'text/plain',
        transportKind: 'http',
        classification: 'public',
      };
    }));
    expect(calls).toEqual(['https://a.acme.dev/doc', 'https://z.acme.dev/doc']);
  });

  it('keeps RFC placeholder URLs literal and rejects authority credentials', async () => {
    expect(isPlaceholderSampleUrl('https://wiki.example.com/prd')).toBe(true);
    expect(hasResolvableSampleUrls([{
      sample_id: 's1', prompt: 'See https://wiki.example.com/prd.',
    }])).toBe(false);

    await expect(resolveSampleContents([{
      sample_id: 's1', prompt: 'See https://user:secret@docs.acme.dev/a',
    }], session(async () => {
      throw new Error('must not run');
    }))).rejects.toBeInstanceOf(SampleContentResolutionError);
  });

  it('fails closed instead of evaluating a raw URL', async () => {
    await expect(resolveSampleContents([{
      sample_id: 's1', prompt: 'See https://docs.acme.dev/a',
    }], session(async () => {
      throw new Error('offline');
    }))).rejects.toMatchObject({
      message: expect.stringContaining('不会退回原始 URL'),
      sourceLabel: 'https://docs.acme.dev',
      sampleIds: ['s1'],
    });
  });
});

describe('createNodeSampleContentResolver', () => {
  it('strictly loads only content-enabled mcpServers', async () => {
    const path = await config({
      mcpServers: {
        runtimeOnly: { command: 'node', args: ['server.mjs'] },
        docs: {
          command: 'node',
          args: ['docs.mjs'],
          urlPatterns: ['docs.acme.dev'],
          fetchTool: { name: 'fetch_doc', urlParam: 'url' },
        },
      },
    });
    const loaded = await loadNodeSampleContentMcpServers(path);
    expect(loaded.map((item) => item.name)).toEqual(['docs']);
  });

  it('uses one MCP client per session, extracts content strictly, and closes it once', async () => {
    const path = await config({
      mcpServers: {
        docs: {
          command: 'node',
          urlPatterns: ['docs.acme.dev'],
          fetchTool: { name: 'fetch_doc', contentExtract: 'data.body' },
        },
      },
    });
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async ({ arguments: args }: { arguments: Record<string, string> }) => ({
      content: [{ type: 'text', text: JSON.stringify({ data: { body: `body:${args.url}` } }) }],
    }));
    const createMcpClient = vi.fn(async () => ({ callTool, close }));
    const resolver = await createNodeSampleContentResolver({ mcpConfigPath: path }, {
      createMcpClient,
      resolveHttp: vi.fn(async () => { throw new Error('must not use HTTP'); }),
    });

    const first = await resolver.resolve('https://docs.acme.dev/a');
    const second = await resolver.resolve('https://docs.acme.dev/b');
    await resolver.close();
    await resolver.close();

    expect(first).toMatchObject({ content: 'body:https://docs.acme.dev/a', transportKind: 'mcp' });
    expect(second).toMatchObject({ content: 'body:https://docs.acme.dev/b', transportKind: 'mcp' });
    expect(createMcpClient).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back to safe HTTP after MCP failure and rejects ambiguous MCP matches', async () => {
    const path = await config({
      mcpServers: {
        docs: {
          command: 'node', urlPatterns: ['docs.acme.dev'], fetchTool: { name: 'fetch' },
        },
      },
    });
    const resolveHttp = vi.fn(async () => ({
      content: 'public fallback',
      mediaType: 'text/plain',
      transportKind: 'http' as const,
      classification: 'public' as const,
    }));
    const resolver = await createNodeSampleContentResolver({ mcpConfigPath: path }, {
      createMcpClient: async () => { throw new Error('MCP unavailable'); },
      resolveHttp,
    });
    await expect(resolver.resolve('https://docs.acme.dev/a')).resolves.toMatchObject({
      content: 'public fallback', transportKind: 'http',
    });
    await resolver.close();

    const ambiguousPath = await config({
      mcpServers: {
        a: { command: 'node', urlPatterns: ['*.acme.dev'], fetchTool: { name: 'fetch' } },
        b: { command: 'node', urlPatterns: ['docs.acme.dev'], fetchTool: { name: 'fetch' } },
      },
    });
    const ambiguous = await createNodeSampleContentResolver({ mcpConfigPath: ambiguousPath }, {
      resolveHttp,
    });
    await expect(ambiguous.resolve('https://docs.acme.dev/a')).rejects.toThrow(/同时匹配多个/);
    await ambiguous.close();
  });

  it('matches MCP resolvers by hostname rather than an attacker-controlled path or query', async () => {
    const path = await config({
      mcpServers: {
        docs: {
          command: 'node', urlPatterns: ['docs.acme.dev'], fetchTool: { name: 'fetch' },
        },
      },
    });
    const createMcpClient = vi.fn(async () => ({
      callTool: async () => ({ content: [{ type: 'text', text: 'private' }] }),
      close: async () => undefined,
    }));
    const resolveHttp = vi.fn(async () => ({
      content: 'public', mediaType: 'text/plain',
      transportKind: 'http' as const, classification: 'public' as const,
    }));
    const resolver = await createNodeSampleContentResolver({ mcpConfigPath: path }, {
      createMcpClient,
      resolveHttp,
    });

    await expect(resolver.resolve(
      'https://attacker.invalid/redirect?next=docs.acme.dev',
    )).resolves.toMatchObject({ content: 'public' });
    expect(createMcpClient).not.toHaveBeenCalled();
    await resolver.close();
  });

  it('blocks private HTTP destinations before sending a request', async () => {
    const resolver = await createNodeSampleContentResolver({});
    await expect(resolver.resolve('http://127.0.0.1/private')).rejects.toThrow(/安全 HTTP resolver/);
    await resolver.close();
  });
});

describe('safe HTTP address policy', () => {
  it.each([
    ['127.0.0.1', 4, false],
    ['10.0.0.1', 4, false],
    ['169.254.169.254', 4, false],
    ['192.168.1.1', 4, false],
    ['8.8.8.8', 4, true],
    ['::1', 6, false],
    ['fc00::1', 6, false],
    ['fe80::1', 6, false],
    ['ff02::1', 6, false],
    ['2606:4700:4700::1111', 6, true],
    ['::ffff:127.0.0.1', 6, false],
    ['::ffff:7f00:1', 6, false],
    ['::ffff:8.8.8.8', 6, true],
    ['64:ff9b::7f00:1', 6, false],
  ] as const)('classifies %s (IPv%i) as public=%s', (address, family, expected) => {
    expect(isPublicNetworkAddress(address, family)).toBe(expected);
  });
});
