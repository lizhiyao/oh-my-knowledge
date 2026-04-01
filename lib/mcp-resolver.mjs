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

// Reuse the same URL regex from url-fetcher.mjs
const URL_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const MCP_CONNECT_TIMEOUT_MS = 30_000;
const MCP_CALL_TIMEOUT_MS = 30_000;

/** Active MCP client connections — keyed by server name. */
const activeClients = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load MCP config from a JSON file.
 * Returns only servers that declare `urlPatterns` + `fetchTool`.
 * Returns null if file not found or no eligible servers.
 *
 * @param {string} [configPath] explicit path, or auto-detect .mcp.json in cwd
 */
export function loadMcpConfig(configPath) {
  const filePath = configPath ? resolve(configPath) : resolve('.mcp.json');
  if (!existsSync(filePath)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`⚠ MCP 配置文件解析失败: ${filePath}\n  ${err.message}\n`);
    return null;
  }

  const servers = raw.mcpServers || raw.servers || {};
  const eligible = {};

  for (const [name, def] of Object.entries(servers)) {
    if (
      Array.isArray(def.urlPatterns) && def.urlPatterns.length > 0 &&
      def.fetchTool && def.fetchTool.name
    ) {
      eligible[name] = def;
    }
  }

  if (Object.keys(eligible).length === 0) return null;
  return eligible;
}

/**
 * Resolve URLs in samples via MCP servers.
 * Mutates samples in-place — same contract as url-fetcher's resolveUrls().
 *
 * @param {Array<{sample_id: string, prompt: string, context?: string}>} samples
 * @param {object} mcpServers  output of loadMcpConfig()
 */
export async function resolveMcpUrls(samples, mcpServers) {
  if (!mcpServers) return;

  // 1. Collect unique URLs and track which sample/field they belong to
  const urlMap = new Map(); // url -> [{sample, field}]
  for (const sample of samples) {
    for (const field of ['prompt', 'context']) {
      const text = sample[field];
      if (!text) continue;
      const matches = text.match(URL_REGEX);
      if (!matches) continue;
      for (const url of matches) {
        if (!urlMap.has(url)) urlMap.set(url, []);
        urlMap.get(url).push({ sample, field });
      }
    }
  }
  if (urlMap.size === 0) return;

  // 2. Match URLs to MCP servers by urlPatterns
  const serverUrlGroups = new Map(); // serverName -> [url]
  const matchedUrls = new Set();

  for (const url of urlMap.keys()) {
    for (const [serverName, def] of Object.entries(mcpServers)) {
      if (def.urlPatterns.some((pattern) => url.includes(pattern))) {
        if (!serverUrlGroups.has(serverName)) serverUrlGroups.set(serverName, []);
        serverUrlGroups.get(serverName).push(url);
        matchedUrls.add(url);
        break; // first match wins
      }
    }
  }

  if (matchedUrls.size === 0) return;

  process.stderr.write(
    `ℹ MCP: ${matchedUrls.size} 个 URL 匹配到 MCP Server，正在获取内容:\n`,
  );
  for (const [serverName, urls] of serverUrlGroups) {
    for (const url of urls) {
      process.stderr.write(`    - [${serverName}] ${url}\n`);
    }
  }

  // 3. Fetch content from each MCP server
  const fetched = new Map(); // url -> { ok, content, error }

  const fetchPromises = [];
  for (const [serverName, urls] of serverUrlGroups) {
    fetchPromises.push(fetchFromServer(serverName, mcpServers[serverName], urls, fetched));
  }
  await Promise.allSettled(fetchPromises);

  // 4. Report failures
  const failCount = [...fetched.values()].filter((r) => !r.ok).length;
  for (const [url, result] of fetched) {
    if (!result.ok) {
      const affectedSamples = urlMap.get(url).map((r) => r.sample.sample_id);
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
    const replacement = `${url}\n\n---\n${result.content}\n---`;
    for (const { sample, field } of urlMap.get(url)) {
      sample[field] = sample[field].replace(url, replacement);
    }
  }

  if (successCount > 0) {
    process.stderr.write(`✓ MCP: 成功获取 ${successCount} 个 URL 的内容\n\n`);
  }
}

/**
 * Close all active MCP client connections.
 * Should be called when the evaluation run finishes.
 */
export async function stopAllServers() {
  const promises = [];
  for (const [name, client] of activeClients) {
    promises.push(
      client.close().catch((err) => {
        process.stderr.write(`⚠ MCP server "${name}" 关闭异常: ${err.message}\n`);
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
function buildToolArgs(fetchTool, url) {
  if (fetchTool.urlTransform) {
    const { regex, params } = fetchTool.urlTransform;
    const match = url.match(new RegExp(regex));
    if (!match) return null;
    const args = {};
    for (const [key, template] of Object.entries(params)) {
      args[key] = template.replace(/\$(\d+)/g, (_, i) => match[Number(i)] || '');
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
function extractContent(rawText, contentExtract) {
  if (!contentExtract) return rawText;
  try {
    const json = JSON.parse(rawText);
    const fields = contentExtract.split('.');
    let value = json;
    for (const field of fields) {
      if (value == null) break;
      value = value[field];
    }
    if (typeof value === 'string' && value.length > 0) return value;
    // If extracted field is an object, stringify it
    if (value != null && typeof value === 'object') return JSON.stringify(value);
  } catch {
    // JSON parse failed, return raw
  }
  return rawText;
}

/**
 * Start an MCP server and return a connected Client.
 */
async function getOrStartClient(serverName, serverDef) {
  if (activeClients.has(serverName)) return activeClients.get(serverName);

  const { command, args = [], env = {} } = serverDef;

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env },
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
async function fetchFromServer(serverName, serverDef, urls, resultMap) {
  let client;
  try {
    client = await getOrStartClient(serverName, serverDef);
  } catch (err) {
    const msg = `MCP server "${serverName}" 启动失败: ${err.message}`;
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

      // MCP tool result: { content: [{ type: 'text', text: '...' }, ...] }
      const textParts = (result.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text);

      if (textParts.length === 0) {
        resultMap.set(url, { ok: false, error: 'MCP tool 返回了空内容' });
      } else {
        const rawContent = textParts.join('\n').trim();
        const content = extractContent(rawContent, fetchTool.contentExtract);
        resultMap.set(url, { ok: true, content });
      }
    } catch (err) {
      resultMap.set(url, { ok: false, error: `tool "${toolName}" 调用失败: ${err.message}` });
    }
  });

  await Promise.allSettled(promises);
}
