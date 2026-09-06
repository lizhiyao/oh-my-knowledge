import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SampleContentResolutionError,
  safeUrlLabel,
  type SampleContentResolution,
  type SampleContentResolverSession,
} from '../../orchestration/sample-content-resolution.js';
import { resolveSafeHttpSampleContent } from './safe-http-content-resolver.js';

const MCP_TIMEOUT_MS = 30_000;

interface SampleContentMcpFetchTool {
  readonly name: string;
  readonly urlParam?: string;
  readonly urlTransform?: {
    readonly regex: string;
    readonly params: Readonly<Record<string, string>>;
  };
  readonly contentExtract?: string;
}

interface SampleContentMcpServerDefinition {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly urlPatterns: readonly string[];
  readonly fetchTool: SampleContentMcpFetchTool;
}

interface ContentMcpServer {
  readonly name: string;
  readonly definition: SampleContentMcpServerDefinition;
}

interface McpClientLike {
  callTool(
    input: { name: string; arguments: Record<string, string> },
    schema?: undefined,
    options?: { timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface NodeSampleContentResolverDependencies {
  readonly resolveHttp?: (url: string) => Promise<SampleContentResolution>;
  readonly createMcpClient?: (
    name: string,
    definition: Readonly<SampleContentMcpServerDefinition>,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<McpClientLike>;
}

export interface NodeSampleContentResolverOptions {
  readonly mcpConfigPath?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function optionalStringRecord(value: unknown): value is Record<string, string> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === 'string'));
}

function parseFetchTool(value: unknown, fieldPath: string): SampleContentMcpFetchTool {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
    throw new TypeError(`${fieldPath} 必须声明非空 name。`);
  }
  if (value.urlParam !== undefined && (typeof value.urlParam !== 'string' || value.urlParam.trim() === '')) {
    throw new TypeError(`${fieldPath}.urlParam 必须是非空字符串。`);
  }
  if (value.contentExtract !== undefined
      && (typeof value.contentExtract !== 'string' || value.contentExtract.trim() === '')) {
    throw new TypeError(`${fieldPath}.contentExtract 必须是非空字符串。`);
  }
  let urlTransform: SampleContentMcpFetchTool['urlTransform'];
  if (value.urlTransform !== undefined) {
    if (!isRecord(value.urlTransform)
        || typeof value.urlTransform.regex !== 'string'
        || !isRecord(value.urlTransform.params)
        || !Object.values(value.urlTransform.params).every((item) => typeof item === 'string')) {
      throw new TypeError(`${fieldPath}.urlTransform 必须声明 regex 与字符串 params。`);
    }
    try {
      new RegExp(value.urlTransform.regex);
    } catch (cause) {
      throw new TypeError(`${fieldPath}.urlTransform.regex 不是合法正则。`, { cause });
    }
    urlTransform = {
      regex: value.urlTransform.regex,
      params: value.urlTransform.params as Record<string, string>,
    };
  }
  return {
    name: value.name,
    ...(value.urlParam === undefined ? {} : { urlParam: value.urlParam as string }),
    ...(urlTransform === undefined ? {} : { urlTransform }),
    ...(value.contentExtract === undefined
      ? {}
      : { contentExtract: value.contentExtract as string }),
  };
}

/** Strictly parses only MCP servers that opt into sample URL resolution. */
export async function loadNodeSampleContentMcpServers(
  configPath: string | undefined,
): Promise<readonly ContentMcpServer[]> {
  if (configPath === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (cause) {
    throw new TypeError('无法读取或解析 MCP config。', { cause });
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new TypeError('MCP config 必须声明 mcpServers object。');
  }
  const servers: ContentMcpServer[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(raw) || raw.urlPatterns === undefined || raw.fetchTool === undefined) continue;
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      throw new TypeError(`mcpServers.${name}.command 必须是非空字符串。`);
    }
    if (!nonEmptyStrings(raw.urlPatterns)) {
      throw new TypeError(`mcpServers.${name}.urlPatterns 必须是非空字符串数组。`);
    }
    if (raw.urlPatterns.some((pattern) => {
      const hostname = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
      return hostname === ''
        || hostname.includes('/')
        || hostname.includes(':')
        || hostname.includes('?')
        || hostname.includes('#')
        || new URL(`https://${hostname}`).hostname.toLowerCase().replace(/\.$/, '')
          !== hostname.toLowerCase().replace(/\.$/, '');
    })) {
      throw new TypeError(`mcpServers.${name}.urlPatterns 只接受精确 hostname 或 *.hostname。`);
    }
    if (!optionalStringArray(raw.args) || !optionalStringRecord(raw.env)) {
      throw new TypeError(`mcpServers.${name} 的 args／env 格式无效。`);
    }
    servers.push({
      name,
      definition: {
        command: raw.command,
        ...(raw.args === undefined ? {} : { args: raw.args }),
        ...(raw.env === undefined ? {} : { env: raw.env }),
        urlPatterns: [...raw.urlPatterns],
        fetchTool: parseFetchTool(raw.fetchTool, `mcpServers.${name}.fetchTool`),
      },
    });
  }
  return servers.sort((left, right) => left.name.localeCompare(right.name));
}

function environmentRecord(environment: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
}

async function defaultCreateMcpClient(
  name: string,
  definition: Readonly<SampleContentMcpServerDefinition>,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<McpClientLike> {
  const transport = new StdioClientTransport({
    command: definition.command,
    args: [...(definition.args ?? [])],
    env: { ...environmentRecord(environment), ...definition.env },
  });
  const client = new Client(
    { name: `omk-sample-content-${name}`, version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
  } catch (cause) {
    try {
      await client.close();
    } catch {
      // Preserve the connect failure; close is best-effort on a partial connection.
    }
    throw cause;
  }
  return client;
}

function buildToolArguments(
  fetchTool: Readonly<SampleContentMcpFetchTool>,
  url: string,
): Record<string, string> {
  if (fetchTool.urlTransform === undefined) return { [fetchTool.urlParam ?? 'url']: url };
  const match = url.match(new RegExp(fetchTool.urlTransform.regex));
  if (match === null) {
    throw new Error('URL 未通过 MCP urlTransform。');
  }
  return Object.fromEntries(Object.entries(fetchTool.urlTransform.params).map(([key, template]) => [
    key,
    template.replace(/\$(\d+)/g, (_whole, index: string) => match[Number(index)] ?? ''),
  ]));
}

function extractMcpContent(result: unknown, contentExtract: string | undefined): string {
  if (!isRecord(result)) throw new Error('MCP tool 返回值不是 object。');
  if (result.isError === true) throw new Error('MCP tool 返回 isError。');
  if (!Array.isArray(result.content)) throw new Error('MCP tool 未返回 content array。');
  const text = result.content
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
    .trim();
  if (text === '') throw new Error('MCP tool 返回了空文本。');
  if (contentExtract === undefined) return text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error('MCP contentExtract 要求 tool 文本是 JSON。', { cause });
  }
  for (const key of contentExtract.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
      throw new Error(`MCP contentExtract 路径不存在：${contentExtract}。`);
    }
    value = value[key];
  }
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  throw new Error(`MCP contentExtract 结果不是文本或 object：${contentExtract}。`);
}

/** Creates one resolver-owned session. Every started MCP client is closed by close(). */
export async function createNodeSampleContentResolver(
  options: Readonly<NodeSampleContentResolverOptions>,
  dependencies: Readonly<NodeSampleContentResolverDependencies> = {},
): Promise<SampleContentResolverSession> {
  const servers = await loadNodeSampleContentMcpServers(options.mcpConfigPath);
  const environment = options.environment ?? process.env;
  const createMcpClient = dependencies.createMcpClient ?? defaultCreateMcpClient;
  const resolveHttp = dependencies.resolveHttp ?? resolveSafeHttpSampleContent;
  const clients = new Map<string, Promise<McpClientLike>>();
  let closed = false;

  const matchesServer = (server: ContentMcpServer, url: string): boolean => {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return server.definition.urlPatterns.some((rawPattern) => {
      const pattern = rawPattern.toLowerCase().replace(/\.$/, '');
      return pattern.startsWith('*.')
        ? hostname.endsWith(`.${pattern.slice(2)}`)
        : hostname === pattern;
    });
  };

  const clientFor = (server: ContentMcpServer): Promise<McpClientLike> => {
    const existing = clients.get(server.name);
    if (existing !== undefined) return existing;
    const created = createMcpClient(server.name, server.definition, environment);
    clients.set(server.name, created);
    return created;
  };

  return {
    async resolve(url): Promise<SampleContentResolution> {
      if (closed) throw new Error('Sample content resolver session 已关闭。');
      const matching = servers.filter((server) => matchesServer(server, url));
      if (matching.length > 1) {
        throw new SampleContentResolutionError({
          message: '同一 Sample URL 同时匹配多个 MCP resolver；请收紧 urlPatterns。',
          sourceLabel: safeUrlLabel(url),
        });
      }
      let mcpFailure: unknown;
      if (matching.length === 1) {
        const server = matching[0]!;
        try {
          const client = await clientFor(server);
          const tool = server.definition.fetchTool;
          const result = await client.callTool(
            { name: tool.name, arguments: buildToolArguments(tool, url) },
            undefined,
            { timeout: MCP_TIMEOUT_MS },
          );
          return {
            content: extractMcpContent(result, tool.contentExtract),
            mediaType: 'text/plain',
            transportKind: 'mcp',
            classification: 'sensitive',
          };
        } catch (cause) {
          mcpFailure = cause;
        }
      }
      try {
        return await resolveHttp(url);
      } catch (httpFailure) {
        throw new SampleContentResolutionError({
          message: matching.length === 0
            ? 'Sample URL 无法通过安全 HTTP resolver 获取。'
            : 'Sample URL 的 MCP resolver 与安全 HTTP fallback 均失败。',
          sourceLabel: safeUrlLabel(url),
          cause: mcpFailure === undefined
            ? httpFailure
            : new AggregateError([mcpFailure, httpFailure], 'MCP and HTTP resolution failed'),
        });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const settledClients = await Promise.allSettled(clients.values());
      const closeResults = await Promise.allSettled(settledClients
        .filter((result): result is PromiseFulfilledResult<McpClientLike> => result.status === 'fulfilled')
        .map((result) => result.value.close()));
      const closeFailures = closeResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (closeFailures.length > 0) {
        throw new AggregateError(closeFailures, 'MCP sample content resolver cleanup failed');
      }
      clients.clear();
    },
  };
}
