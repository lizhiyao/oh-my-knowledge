/**
 * MCP-based URL resolver for eval-samples.
 *
 * Reads a MCP config file (.mcp.json), launches configured MCP servers,
 * and uses them to fetch URL content that cannot be reached via plain HTTP
 * (e.g. internal Yuque documents behind SSO).
 *
 * Config format (.mcp.json):
 * {
 *   "mcpServers": {
 *     "yuque": {
 *       "command": "npx",
 *       "args": ["@example/docs-mcp-server"],
 *       "env": { "YUQUE_API_TOKEN": "xxx" },
 *       "urlPatterns": ["docs.example.com"],
 *       "fetchTool": { "name": "get_doc", "urlParam": "url" }
 *     }
 *   }
 * }
 *
 * Advanced: urlTransform + contentExtract for complex MCP tools:
 * {
 *   "fetchTool": {
 *     "name": "fetch_doc",
 *     "urlTransform": {
 *       "regex": "yuque\\.antfin\\.com/([^/]+/[^/]+)/([^/?#]+)",
 *       "params": { "namespace": "$1", "slug": "$2" }
 *     },
 *     "contentExtract": "data.body"
 *   }
 * }
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isPlaceholderUrl } from './url-fetcher.js';
import type { Sample, McpServers, McpServerDef, McpFetchTool } from '../types.js';

// Reuse the same URL regex from url-fetcher.mjs
const URL_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const MCP_CALL_TIMEOUT_MS = 30_000;

/** Active MCP client connections — keyed by server name. */
const activeClients = new Map<string, Client>();

interface FetchResult {
  ok: boolean;
  content?: string;
  error?: string;
}

interface ToolContentItem {
  type?: string;
  text?: string;
}

interface ToolCallResultLike {
  content?: ToolContentItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMcpServerDef(value: unknown): value is McpServerDef {
  if (!isRecord(value)) return false;
  return typeof value.command === 'string'
    && Array.isArray(value.urlPatterns)
    && isRecord(value.fetchTool)
    && typeof value.fetchTool.name === 'string';
}

function asToolCallResult(value: unknown): ToolCallResultLike {
  return isRecord(value) ? value as ToolCallResultLike : {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load MCP config from a JSON file.
 * Returns only servers that declare `urlPatterns` + `fetchTool`.
 * Returns null if file not found or no eligible servers.
 */
export function loadMcpConfig(configPath?: string): McpServers | null {
  const filePath = configPath ? resolve(configPath) : resolve('.mcp.json');
  if (!existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err: unknown) {
    process.stderr.write(`⚠ MCP 配置文件解析失败: ${filePath}\n  ${getErrorMessage(err)}\n`);
    return null;
  }

  if (!isRecord(raw)) return null;
  const serverDefs = isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw.servers) ? raw.servers : {};
  const eligible: McpServers = {};

  for (const [name, def] of Object.entries(serverDefs)) {
    if (isMcpServerDef(def) && def.urlPatterns.length > 0) {
      eligible[name] = def;
    }
  }

  if (Object.keys(eligible).length === 0) return null;
  return eligible;
}

/**
 * Resolve URLs in samples via MCP servers.
 * Mutates samples in-place — same contract as url-fetcher's resolveUrls().
 */
export async function resolveMcpUrls(samples: Sample[], mcpServers: McpServers | null): Promise<Set<string>> {
  const resolved = new Set<string>();
  if (!mcpServers) return resolved;

  // 1. Collect unique URLs and track which sample/field they belong to
  const urlMap = new Map<string, Array<{ sample: Sample; field: string }>>(); // url -> [{sample, field}]
  for (const sample of samples) {
    for (const field of ['prompt', 'context'] as const) {
      const text = sample[field] as string | undefined;
      if (!text) continue;
      const matches = text.match(URL_REGEX);
      if (!matches) continue;
      for (const url of matches) {
        if (isPlaceholderUrl(url)) continue; // RFC 2606 placeholder domains are documentation-only
        if (!urlMap.has(url)) urlMap.set(url, []);
        urlMap.get(url)!.push({ sample, field });
      }
    }
  }
  if (urlMap.size === 0) return resolved;

  // 2. Match URLs to MCP servers by urlPatterns
  const serverUrlGroups = new Map<string, string[]>(); // serverName -> [url]
  const matchedUrls = new Set<string>();

  for (const url of urlMap.keys()) {
    for (const [serverName, def] of Object.entries(mcpServers)) {
      if (def.urlPatterns.some((pattern) => url.includes(pattern))) {
        if (!serverUrlGroups.has(serverName)) serverUrlGroups.set(serverName, []);
        serverUrlGroups.get(serverName)!.push(url);
        matchedUrls.add(url);
        break; // first match wins
      }
    }
  }

  if (matchedUrls.size === 0) return resolved;

  process.stderr.write(
    `ℹ MCP: ${matchedUrls.size} 个 URL 匹配到 MCP Server，正在获取内容:\n`,
  );
  for (const [serverName, urls] of serverUrlGroups) {
    for (const url of urls) {
      process.stderr.write(`    - [${serverName}] ${url}\n`);
    }
  }

  // 3. Fetch content from each MCP server
  const fetched = new Map<string, FetchResult>(); // url -> { ok, content, error }

  const fetchPromises: Promise<void>[] = [];
  for (const [serverName, urls] of serverUrlGroups) {
    fetchPromises.push(fetchFromServer(serverName, mcpServers[serverName], urls, fetched));
  }
  await Promise.allSettled(fetchPromises);

  // 4. Report failures
  const failCount = [...fetched.values()].filter((r) => !r.ok).length;
  for (const [url, result] of fetched) {
    if (!result.ok) {
      const affectedSamples = urlMap.get(url)!.map((r) => r.sample.sample_id);
      const unique = [...new Set(affectedSamples)];
      process.stderr.write(
        `\n✗ MCP 获取失败 (sample ${unique.map((id) => `"${id}"`).join(', ')}):\n` +
        `  URL: ${url}\n` +
        `  错误: ${result.error}\n`,
      );
    }
  }
  if (failCount > 0) {
    process.stderr.write(`\n⚠ ${failCount} 个 URL 通过 MCP 获取失败，将尝试 HTTP 回退\n\n`);
  }

  // 5. Inline successful results into samples
  const successCount = [...fetched.values()].filter((r) => r.ok).length;
  for (const [url, result] of fetched) {
    if (!result.ok) continue;
    resolved.add(url);
    const replacement = `${url}\n\n---\n${result.content}\n---`;
    for (const { sample, field } of urlMap.get(url)!) {
      const current = typeof sample[field] === 'string' ? sample[field] : '';
      sample[field] = current.replace(url, replacement);
    }
  }

  if (successCount > 0) {
    process.stderr.write(`✓ MCP: 成功获取 ${successCount} 个 URL 的内容\n\n`);
  }

  return resolved;
}

/**
 * Close all active MCP client connections.
 * Should be called when the evaluation run finishes.
 */
export async function stopAllServers(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [name, client] of activeClients) {
    promises.push(
      client.close().catch((err: unknown) => {
        process.stderr.write(`⚠ MCP server "${name}" 关闭异常: ${getErrorMessage(err)}\n`);
      }),
    );
  }
  await Promise.allSettled(promises);
  activeClients.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build tool arguments from a URL, using either simple urlParam or urlTransform.
 * Returns null if urlTransform regex doesn't match.
 */
function buildToolArgs(fetchTool: McpFetchTool, url: string): Record<string, string> | null {
  if (fetchTool.urlTransform) {
    const { regex, params } = fetchTool.urlTransform;
    const match = url.match(new RegExp(regex));
    if (!match) return null;
    const args: Record<string, string> = {};
    for (const [key, template] of Object.entries(params)) {
      args[key] = template.replace(/\$(\d+)/g, (_: string, i: string) => match[Number(i)] || '');
    }
    return args;
  }
  // Simple mode: pass URL as a single param
  const urlParam = fetchTool.urlParam || 'url';
  return { [urlParam]: url };
}

/**
 * Extract content from MCP tool response text.
 * If contentExtract is configured (e.g. "data.body"), parse JSON and traverse path.
 * Falls back to raw text if extraction fails.
 */
function extractContent(rawText: string, contentExtract?: string): string {
  if (!contentExtract) return rawText;
  try {
    const json = JSON.parse(rawText);
    const fields = contentExtract.split('.');
    let value: unknown = json;
    for (const field of fields) {
      if (!isRecord(value)) {
        value = undefined;
        break;
      }
      value = value[field];
    }
    if (typeof value === 'string' && value.length > 0) return value;
    if (value != null && typeof value === 'object') return JSON.stringify(value);
  } catch {
  }
  return rawText;
}

/**
 * Start an MCP server and return a connected Client.
 */
async function getOrStartClient(serverName: string, serverDef: McpServerDef): Promise<Client> {
  if (activeClients.has(serverName)) return activeClients.get(serverName)!;

  const { command, args = [], env = {} } = serverDef;

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });

  const client = new Client(
    { name: `omk-${serverName}`, version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  activeClients.set(serverName, client);
  return client;
}

/**
 * Fetch a batch of URLs from a single MCP server.
 */
async function fetchFromServer(serverName: string, serverDef: McpServerDef, urls: string[], resultMap: Map<string, FetchResult>): Promise<void> {
  let client: Client;
  try {
    client = await getOrStartClient(serverName, serverDef);
  } catch (err: unknown) {
    const msg = `MCP server "${serverName}" 启动失败: ${getErrorMessage(err)}`;
    for (const url of urls) {
      resultMap.set(url, { ok: false, error: msg });
    }
    return;
  }

  const { fetchTool } = serverDef;
  const toolName = fetchTool.name;

  const promises = urls.map(async (url) => {
    try {
      const toolArgs = buildToolArgs(fetchTool, url);
      if (!toolArgs) {
        resultMap.set(url, { ok: false, error: `URL 不匹配 urlTransform 正则: ${fetchTool.urlTransform?.regex}` });
        return;
      }
      const result = await client.callTool(
        { name: toolName, arguments: toolArgs },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS },
      );
      const textParts = (asToolCallResult(result).content ?? [])
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text as string);

      if (textParts.length === 0) {
        resultMap.set(url, { ok: false, error: 'MCP tool 返回了空内容' });
      } else {
        const rawContent = textParts.join('\n').trim();
        const content = extractContent(rawContent, fetchTool.contentExtract);
        resultMap.set(url, { ok: true, content });
      }
    } catch (err: unknown) {
      resultMap.set(url, { ok: false, error: `tool "${toolName}" 调用失败: ${getErrorMessage(err)}` });
    }
  });

  await Promise.allSettled(promises);
}
