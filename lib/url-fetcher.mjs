/**
 * URL content fetcher for eval-samples.
 *
 * Scans sample prompts/contexts for URLs, fetches their content,
 * and inlines the text back into the sample fields.
 *
 * Two-stage fetch strategy:
 *   1. Plain HTTP fetch (fast, free)
 *   2. On auth failure, fallback to `claude -p` which can use MCP tools for authenticated access
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Match URLs using RFC 3986 allowed characters (whitelist approach).
// This avoids accidentally consuming CJK characters or punctuation adjacent to URLs.
const URL_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const FETCH_TIMEOUT_MS = 30_000;
const CLAUDE_FETCH_TIMEOUT_MS = 60_000;

/**
 * Resolve all URLs found in sample prompts and contexts.
 * Mutates samples in-place: each URL is replaced with URL + fetched content.
 *
 * @param {Array<{sample_id: string, prompt: string, context?: string}>} samples
 */
export async function resolveUrls(samples) {
  // 1. Collect all unique URLs across all samples, tracking which sample they belong to
  const urlMap = new Map(); // url -> Set<{sample, field}>
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

  // 2. Fetch all unique URLs concurrently
  const fetched = new Map(); // url -> { ok, content, error }
  const entries = [...urlMap.keys()];

  process.stderr.write(`ℹ 检测到 ${entries.length} 个 URL，正在获取内容:\n`);
  for (const url of entries) {
    process.stderr.write(`    - ${url}\n`);
  }

  const results = await Promise.allSettled(
    entries.map((url) => fetchUrl(url)),
  );

  for (let i = 0; i < entries.length; i++) {
    const url = entries[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      fetched.set(url, result.value);
    } else {
      fetched.set(url, { ok: false, error: result.reason.message || 'unknown error' });
    }
  }

  // 3. For auth failures, fallback to claude -p with MCP
  const authFailedUrls = [...fetched.entries()]
    .filter(([, r]) => !r.ok && isAuthFailure(r))
    .map(([url]) => url);

  if (authFailedUrls.length > 0) {
    process.stderr.write(`ℹ ${authFailedUrls.length} 个 URL 需要认证，尝试通过 Claude MCP 获取:\n`);
    for (const url of authFailedUrls) {
      process.stderr.write(`    - ${url}\n`);
    }
    const mcpResults = await Promise.allSettled(
      authFailedUrls.map((url) => fetchViaClaudeMcp(url)),
    );
    for (let i = 0; i < authFailedUrls.length; i++) {
      const url = authFailedUrls[i];
      const result = mcpResults[i];
      if (result.status === 'fulfilled' && result.value.ok) {
        fetched.set(url, result.value);
      }
      // If MCP also fails, keep the original error for better diagnostics
    }
  }

  // 4. Check for remaining failures and build error message
  const errors = [];
  for (const [url, result] of fetched) {
    if (!result.ok) {
      const affectedSamples = urlMap.get(url).map((r) => r.sample.sample_id);
      const unique = [...new Set(affectedSamples)];
      errors.push(formatError(url, result, unique));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `URL 内容抓取失败，评测终止:\n\n${errors.join('\n\n')}`,
    );
  }

  // 4. Inline fetched content into samples
  for (const [url, result] of fetched) {
    const replacement = `${url}\n\n---\n${result.content}\n---`;
    for (const { sample, field } of urlMap.get(url)) {
      sample[field] = sample[field].replace(url, replacement);
    }
  }
}

/**
 * Fetch a single URL and return its text content.
 */
async function fetchUrl(url) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'oh-my-knowledge/url-fetcher',
        'Accept': 'text/html, text/plain, */*',
      },
      redirect: 'follow',
    });
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      error: networkErrorMessage(err),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: `${response.status} ${response.statusText}`,
    };
  }

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  const content = contentType.includes('text/html')
    ? htmlToText(raw)
    : raw.trim();

  // Detect login/redirect pages that return 200 but no real content
  const loginHint = detectLoginPage(content);
  if (loginHint) {
    return {
      ok: false,
      statusCode: 200,
      error: `页面返回了登录/跳转页而非实际内容 (${loginHint})`,
      isLoginPage: true,
    };
  }

  return { ok: true, content };
}

/**
 * Check if a fetch failure is auth-related (worth retrying via MCP).
 */
function isAuthFailure(result) {
  if (result.isLoginPage) return true;
  if (result.statusCode === 401 || result.statusCode === 403) return true;
  return false;
}

/**
 * Fallback: use `claude -p` to fetch URL content via MCP tools.
 * Claude can leverage configured MCP servers (e.g.  for Yuque)
 * to access authenticated content.
 */
async function fetchViaClaudeMcp(url) {
  const prompt = [
    '请获取以下 URL 的完整文档内容。',
    '',
    `URL: ${url}`,
    '',
    '要求：',
    '- 如果成功获取到文档内容，第一行输出 "STATUS:OK"，然后空一行，输出完整文档正文',
    '- 如果无法获取（无权限、链接无效、工具不可用等），第一行输出 "STATUS:FAIL"，然后空一行，输出失败原因',
    '- 不要添加任何其他解释、总结或格式化',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--model', 'haiku',
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: CLAUDE_FETCH_TIMEOUT_MS,
      env: { ...process.env },
    });
    const data = JSON.parse(stdout);
    if (data.is_error) {
      return { ok: false, error: data.result || 'claude MCP fetch failed' };
    }
    const content = (data.result || '').trim();
    // Parse structured response
    if (content.startsWith('STATUS:OK')) {
      const body = content.replace(/^STATUS:OK\s*/, '').trim();
      if (!body || body.length < 50) {
        return { ok: false, error: 'Claude MCP 返回内容为空或过短' };
      }
      return { ok: true, content: body };
    }
    // STATUS:FAIL or unrecognized format — treat as failure
    const reason = content.replace(/^STATUS:FAIL\s*/, '').trim();
    return { ok: false, error: reason || 'Claude 无法通过 MCP 获取该 URL 内容' };
  } catch (err) {
    if (err.killed) {
      return { ok: false, error: `Claude MCP 获取超时 (${CLAUDE_FETCH_TIMEOUT_MS / 1000}s)` };
    }
    return { ok: false, error: `Claude MCP 获取失败: ${err.message}` };
  }
}

/**
 * Strip HTML tags to extract readable text.
 */
function htmlToText(html) {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Detect login/auth redirect pages that return HTTP 200 but no real content.
 * Returns a hint string if detected, null otherwise.
 */
function detectLoginPage(content) {
  if (content.length < 50) return '内容过短';
  const lower = content.toLowerCase();
  const loginPatterns = [
    '欢迎使用docs', 'login', 'sign in', 'sign_in', '登录', '请登录',
    'sso', 'redirect_uri', 'oauth', 'unauthorized', 'cas/login',
  ];
  for (const pattern of loginPatterns) {
    // Only flag if the content is very short (likely a login page, not a long doc that mentions login)
    if (lower.includes(pattern) && content.length < 500) {
      return pattern;
    }
  }
  return null;
}

/**
 * Map network errors to user-friendly messages.
 */
function networkErrorMessage(err) {
  const code = err.cause?.code || err.code || '';
  if (code === 'ENOTFOUND') return '域名无法解析，请检查 URL 是否正确';
  if (code === 'ECONNREFUSED') return '连接被拒绝，请检查网络或代理配置';
  if (code === 'ECONNRESET') return '连接被重置，请检查网络';
  if (err.name === 'TimeoutError' || code === 'ABORT_ERR') return `请求超时 (${FETCH_TIMEOUT_MS / 1000}s)`;
  return err.message || 'unknown network error';
}

/**
 * Format a fetch error with actionable solution.
 */
function formatError(url, result, sampleIds) {
  const sampleLabel = sampleIds.map((id) => `"${id}"`).join(', ');
  const lines = [
    `✗ sample ${sampleLabel}: URL 无法访问`,
    `  URL: ${url}`,
  ];

  if (result.statusCode) {
    lines.push(`  状态: ${result.error}`);
  } else {
    lines.push(`  错误: ${result.error}`);
  }

  lines.push(`  解决方案: ${getSolution(result.statusCode, result)}`);
  return lines.join('\n');
}

/**
 * Map HTTP status code to actionable solution text.
 */
function getSolution(statusCode, result) {
  if (result?.isLoginPage) {
    return '该链接返回了登录页而非实际内容，需要认证才能访问，请将文档内容复制到 eval-samples 的 context 字段中';
  }
  if (statusCode === 401 || statusCode === 403) {
    return '该链接需要登录认证，请将文档内容复制到 eval-samples 的 context 字段中';
  }
  if (statusCode === 404) {
    return '页面不存在，请检查链接是否正确';
  }
  if (statusCode >= 500) {
    return '服务端错误，请稍后重试';
  }
  // Network errors (statusCode === 0) or other
  if (!statusCode) {
    return '无法连接目标服务，请检查网络或代理配置，或将文档内容复制到 eval-samples 的 context 字段中';
  }
  return '请将文档内容复制到 eval-samples 的 context 字段中';
}
