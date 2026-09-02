import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { SampleContentResolution } from './sample-content-resolution.js';

const HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2002::', 16],
  ['3fff::', 20],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export function isPublicNetworkAddress(address: string, family: 4 | 6): boolean {
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    const embedded = address.slice('::ffff:'.length);
    return isIP(embedded) === 4 && !blockedAddresses.check(embedded, 'ipv4');
  }
  return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function pinnedPublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
  const literalFamily = isIP(normalized);
  const addresses = literalFamily === 0
    ? await lookup(normalized, { all: true, verbatim: true })
    : [{ address: normalized, family: literalFamily }];
  if (addresses.length === 0 || addresses.some((item) => (
    (item.family !== 4 && item.family !== 6)
      || !isPublicNetworkAddress(item.address, item.family as 4 | 6)
  ))) {
    throw new Error('HTTP URL 解析到了非公网地址。私有文档必须通过显式 MCP resolver。');
  }
  return addresses
    .map((item) => ({ address: item.address, family: item.family as 4 | 6 }))
    .sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))[0]!;
}

function responseFor(
  url: URL,
  address: { address: string; family: 4 | 6 },
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, {
      headers: {
        accept: 'text/plain, text/markdown, text/html, application/json, application/xml;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'oh-my-knowledge/sample-content-resolver',
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      signal,
    }, resolve);
    request.once('error', reject);
    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`HTTP 内容解析超过 ${HTTP_TIMEOUT_MS}ms。`));
    });
    request.end();
  });
}

function supportedTextMediaType(value: string | undefined): string {
  if (value === undefined) throw new Error('HTTP 响应缺少 Content-Type，无法证明其为文本。');
  const [rawMediaType, ...parameters] = value.split(';');
  const mediaType = rawMediaType!.trim().toLowerCase();
  const charset = parameters
    .map((parameter) => parameter.trim().match(/^charset\s*=\s*"?([^"\s]+)"?$/i)?.[1])
    .find((candidate) => candidate !== undefined)
    ?.toLowerCase();
  if (charset !== undefined && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) {
    throw new Error(`HTTP resolver 只接受 UTF-8 文本，收到 charset=${charset}。`);
  }
  if (mediaType.startsWith('text/')
      || /^application\/(?:[a-z0-9_.-]+\+)?json$/.test(mediaType)
      || /^application\/(?:[a-z0-9_.-]+\+)?xml$/.test(mediaType)
      || ['application/yaml', 'application/x-yaml'].includes(mediaType)) return mediaType;
  throw new Error(`HTTP Content-Type 不支持作为 sample 文本：${mediaType}。`);
}

async function boundedBody(response: IncomingMessage): Promise<Buffer> {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_HTTP_BYTES) {
    response.destroy();
    throw new Error(`HTTP 内容超过 ${MAX_HTTP_BYTES} bytes 上限。`);
  }
  if (response.headers['content-encoding'] !== undefined
      && response.headers['content-encoding'] !== 'identity') {
    response.destroy();
    throw new Error('HTTP resolver 只接受 identity content encoding。');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_HTTP_BYTES) {
      response.destroy();
      throw new Error(`HTTP 内容超过 ${MAX_HTTP_BYTES} bytes 上限。`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fetches public text while pinning validated DNS results across each request hop. */
export async function resolveSafeHttpSampleContent(
  urlString: string,
): Promise<SampleContentResolution> {
  let current = new URL(urlString);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('HTTP resolver 只接受 http／https URL。');
    }
    if (current.username !== '' || current.password !== '') {
      throw new Error('HTTP URL 不得携带 authority credentials。');
    }
    const expectedPort = current.protocol === 'https:' ? '443' : '80';
    if (current.port !== '' && current.port !== expectedPort) {
      throw new Error('安全 HTTP resolver 只允许协议默认端口；其它端口请通过 MCP resolver。');
    }
    const address = await pinnedPublicAddress(current.hostname);
    const response = await responseFor(current, address, AbortSignal.timeout(HTTP_TIMEOUT_MS));
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (location === undefined) throw new Error(`HTTP ${status} 缺少 Location。`);
      if (redirect === MAX_REDIRECTS) throw new Error(`HTTP redirect 超过 ${MAX_REDIRECTS} 次。`);
      current = new URL(location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`HTTP 内容解析失败，状态码 ${status}。`);
    }
    let mediaType: string;
    try {
      mediaType = supportedTextMediaType(response.headers['content-type']);
    } catch (cause) {
      response.destroy();
      throw cause;
    }
    const bytes = await boundedBody(response);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new Error('HTTP 内容不是有效 UTF-8 文本。', { cause });
    }
    return {
      content: mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
        ? htmlToText(text)
        : text,
      mediaType: mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
        ? 'text/plain'
        : mediaType,
      transportKind: 'http',
      classification: 'public',
    };
  }
  throw new Error('HTTP redirect 解析未终止。');
}
