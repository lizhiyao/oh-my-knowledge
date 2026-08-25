import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ObservationCaptureStore } from './capture-store.js';
import { createChatGptObservationMcpServer } from './mcp-server.js';
import {
  assertObservationCaptureScope,
  LOCAL_OBSERVATION_PRINCIPAL,
  ObservationPrincipalError,
  validateObservationPrincipal,
  type PrincipalResolver,
} from './principal.js';

const DEFAULT_PATH = '/mcp';
const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

export interface ChatGptObservationHttpOptions {
  captureStore: ObservationCaptureStore;
  principalResolver?: PrincipalResolver<IncomingMessage>;
  path?: string;
  requestBodyLimitBytes?: number;
  requestBodyTimeoutMs?: number;
  maxConcurrentRequests?: number;
}

export interface ChatGptObservationHttpListenOptions extends ChatGptObservationHttpOptions {
  host?: string;
  port?: number;
}

export interface StartedChatGptObservationHttpServer {
  server: Server;
  url: URL;
  close(): Promise<void>;
}

export class ObservationHttpTransportError extends Error {
  constructor(
    readonly code: 'body_too_large' | 'request_timeout' | 'transport_failed',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ObservationHttpTransportError';
  }
}

export function createChatGptObservationHttpHandler(
  options: ChatGptObservationHttpOptions,
): RequestListener {
  const path = validatePath(options.path ?? DEFAULT_PATH);
  const bodyLimit = positiveInteger(
    options.requestBodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    'requestBodyLimitBytes',
  );
  const timeoutMs = positiveInteger(
    options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestBodyTimeoutMs',
  );
  const concurrencyLimit = positiveInteger(
    options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    'maxConcurrentRequests',
  );
  const resolver = options.principalResolver ?? {
    async resolve() {
      return LOCAL_OBSERVATION_PRINCIPAL;
    },
  } satisfies PrincipalResolver<IncomingMessage>;
  let activeRequests = 0;

  return async (request, response) => {
    if (!options.principalResolver) {
      if (!isLoopbackHost(request.socket.localAddress ?? '')) {
        sendJsonRpcError(response, 401, -32001, 'Authentication required.');
        return;
      }
      if (
        !isLoopbackAuthority(request.headers.host)
        || !isAllowedLoopbackOrigin(request.headers.origin)
      ) {
        sendJsonRpcError(response, 403, -32001, 'Forbidden.');
        return;
      }
    }
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== path) {
      sendJsonRpcError(response, 404, -32004, 'Not found.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJsonRpcError(response, 405, -32000, 'Method not allowed.');
      return;
    }
    if (activeRequests >= concurrencyLimit) {
      sendJsonRpcError(response, 503, -32003, 'Server busy.');
      return;
    }

    activeRequests += 1;
    try {
      const principal = validateObservationPrincipal(await resolver.resolve(request));
      assertObservationCaptureScope(principal);
      const body = await readJsonBody(request, bodyLimit, timeoutMs);
      const server = createChatGptObservationMcpServer({
        principal,
        captureStore: options.captureStore,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      response.once('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      handleHttpError(response, error);
    } finally {
      activeRequests -= 1;
    }
  };
}

export async function startChatGptObservationHttpServer(
  options: ChatGptObservationHttpListenOptions,
): Promise<StartedChatGptObservationHttpServer> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !options.principalResolver) {
    throw new Error('监听非 loopback 地址时必须提供 principalResolver。');
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port 必须是 0 至 65535 的整数。');
  }
  const server = createServer(createChatGptObservationHttpHandler(options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const path = validatePath(options.path ?? DEFAULT_PATH);
  return {
    server,
    url: new URL(`http://${displayHost}:${address.port}${path}`),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function readJsonBody(
  request: IncomingMessage,
  bodyLimit: number,
  timeoutMs: number,
): Promise<unknown> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    request.resume();
    throw new ObservationHttpTransportError('body_too_large', 'Request body too large.');
  }
  let total = 0;
  const chunks: Buffer[] = [];
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > bodyLimit) {
            request.resume();
            throw new ObservationHttpTransportError('body_too_large', 'Request body too large.');
          }
          chunks.push(buffer);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          request.resume();
          reject(new ObservationHttpTransportError('request_timeout', 'Request timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new ObservationHttpTransportError('transport_failed', 'Request body must be valid JSON.', {
      cause: error,
    });
  }
}

function handleHttpError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  if (error instanceof ObservationPrincipalError) {
    sendJsonRpcError(response, error.statusCode, -32001, error.statusCode === 401
      ? 'Authentication required.'
      : 'Forbidden.');
    return;
  }
  if (error instanceof ObservationHttpTransportError) {
    const statusCode = error.code === 'body_too_large'
      ? 413
      : error.code === 'request_timeout'
        ? 408
        : 400;
    sendJsonRpcError(response, statusCode, -32600, error.message);
    return;
  }
  sendJsonRpcError(response, 500, -32603, 'Internal server error.');
}

function sendJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}

function validatePath(value: string): string {
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error('path 必须是以 / 开头且不含 query 或 fragment 的 URL path。');
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数。`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const parts = normalized.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.slice(1).every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false;
  try {
    return isLoopbackHost(new URL(`http://${authority}`).hostname);
  } catch {
    return false;
  }
}

function isAllowedLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const value = new URL(origin);
    return (value.protocol === 'http:' || value.protocol === 'https:')
      && isLoopbackHost(value.hostname);
  } catch {
    return false;
  }
}
