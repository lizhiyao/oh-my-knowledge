/**
 * URL content fetcher for eval-samples.
 *
 * Scans sample prompts/contexts for URLs, fetches their content,
 * and inlines the text back into the sample fields.
 *
 * If a URL requires authentication, ensure the CLI environment can access it
 * (e.g., via VPN, proxy, cookies) before running the evaluation.
 */

import type { Sample } from './types.js';

// Match URLs using RFC 3986 allowed characters (whitelist approach).
// This avoids accidentally consuming CJK characters or punctuation adjacent to URLs.
const URL_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const FETCH_TIMEOUT_MS = 30_000;

interface FetchResult {
  ok: boolean;
  content?: string;
  error?: string;
  statusCode?: number;
  isLoginPage?: boolean;
}

/**
 * Resolve all URLs found in sample prompts and contexts.
 * Mutates samples in-place: each URL is replaced with URL + fetched content.
 */
export async function resolveUrls(samples: Sample[]): Promise<void> {
  // 1. Collect all unique URLs across all samples, tracking which sample they belong to
  const urlMap = new Map<string, Array<{ sample: Sample; field: string }>>(); // url -> [{sample, field}]
  for (const sample of samples) {
    for (const field of ['prompt', 'context'] as const) {
      const text = sample[field] as string | undefined;
      if (!text) continue;
      const matches = text.match(URL_REGEX);
      if (!matches) continue;
      for (const url of matches) {
        if (!urlMap.has(url)) urlMap.set(url, []);
        urlMap.get(url)!.push({ sample, field });
      }
    }
  }

  if (urlMap.size === 0) return;

  // 2. Fetch all unique URLs concurrently
  const fetched = new Map<string, FetchResult>(); // url -> { ok, content, error }
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
      fetched.set(url, { ok: false, error: (result.reason as Error).message || 'unknown error' });
    }
  }

  // 3. Warn about failures, inline successes
  for (const [url, result] of fetched) {
    if (!result.ok) {
      const affectedSamples = urlMap.get(url)!.map((r) => r.sample.sample_id);
      const unique = [...new Set(affectedSamples)];
      process.stderr.write(`\n${formatError(url, result, unique)}\n`);
    }
  }

  const failCount = [...fetched.values()].filter((r) => !r.ok).length;
  if (failCount > 0) {
    process.stderr.write(`\n⚠ ${failCount} 个 URL 抓取失败，将使用原始 URL 继续评测\n\n`);
  }

  // 4. Inline fetched content into samples (only successful ones)
  for (const [url, result] of fetched) {
    if (!result.ok) continue;
    const replacement = `${url}\n\n---\n${result.content}\n---`;
    for (const { sample, field } of urlMap.get(url)!) {
      (sample as any)[field] = ((sample as any)[field] as string).replace(url, replacement);
    }
  }
}

/**
 * Fetch a single URL and return its text content.
 */
async function fetchUrl(url: string): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'oh-my-knowledge/url-fetcher',
        'Accept': 'text/html, text/plain, */*',
      },
      redirect: 'follow',
    });
  } catch (err: any) {
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
 * Strip HTML tags to extract readable text.
 */
function htmlToText(html: string): string {
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
function detectLoginPage(content: string): string | null {
  if (content.length < 50) return '内容过短';
  const lower = content.toLowerCase();
  const loginPatterns = [
    'login', 'sign in', 'sign_in', 'sso', 'redirect_uri',
    'oauth', 'unauthorized', 'cas/login',
  ];
  for (const pattern of loginPatterns) {
    if (lower.includes(pattern) && content.length < 500) {
      return pattern;
    }
  }
  return null;
}

/**
 * Map network errors to user-friendly messages.
 */
function networkErrorMessage(err: any): string {
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
function formatError(url: string, result: FetchResult, sampleIds: string[]): string {
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
function getSolution(statusCode: number | undefined, result: FetchResult): string {
  if (result?.isLoginPage) {
    return '该链接需要认证，请确保命令行环境可正常访问（如配置 VPN/代理/cookie），或将文档内容复制到 eval-samples 的 context 字段中';
  }
  if (statusCode === 401 || statusCode === 403) {
    return '该链接需要认证，请确保命令行环境可正常访问，或将文档内容复制到 eval-samples 的 context 字段中';
  }
  if (statusCode === 404) {
    return '页面不存在，请检查链接是否正确';
  }
  if (statusCode && statusCode >= 500) {
    return '服务端错误，请稍后重试';
  }
  if (!statusCode) {
    return '无法连接目标服务，请检查网络或代理配置，或将文档内容复制到 eval-samples 的 context 字段中';
  }
  return '请将文档内容复制到 eval-samples 的 context 字段中';
}
