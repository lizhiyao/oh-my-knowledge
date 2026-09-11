import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReportServer, ReportServerOptions } from './contracts.js';
import type { StudioAppHost } from './app-host.js';
import { getErrorMessage, STUDIO_INTERNAL_ERROR, TEXT_HEADERS } from './errors.js';
import { createStudioRequestHandler } from './request-handler.js';

const DEFAULT_PORT = 7799;
const PORT_HINT = `OMK_REPORT_PORT=${DEFAULT_PORT} omk eval ...`;

// Returns Error to throw, or null when caller should fall through to the
// EADDRINUSE / omk-takeover flow. Splits occupancy from permission and
// ephemeral-bind rejection so users see a fix path that matches the cause.
export function formatListenError(port: number, error: unknown): Error | null {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;

  if (port === 0) {
    return new Error(
      `cannot bind ephemeral port (--port 0): ${errno ?? 'unknown error'}.\n` +
      '  likely cause: sandboxed / restricted network environment ' +
      '(Docker without --net=host, container without bind permission).\n' +
      `  try a fixed port: ${PORT_HINT}`
    );
  }

  if (errno === 'EACCES' || errno === 'EPERM') {
    return new Error(
      `cannot bind port ${port}: permission denied (${errno}).\n` +
      '  ports < 1024 require root on Unix; sandboxed environments may block all binds.\n' +
      `  pick another unblocked port: ${PORT_HINT}`
    );
  }

  if (errno && errno !== 'EADDRINUSE') {
    return new Error(
      `cannot bind port ${port}: ${errno} (${getErrorMessage(error)}).\n` +
      `  pick another port: ${PORT_HINT}`
    );
  }

  return null;
}

export function createReportServer(options: ReportServerOptions = {}, presentation?: StudioAppHost): ReportServer {
  const {
    port,
    host: hostOption,
    ...requestOptions
  } = options;
  let server: Server | null = null;
  let serverUrl: string | null = null;
  let transition: Promise<unknown> = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = transition.then(action);
    transition = result.catch(() => undefined);
    return result;
  }
  const requestHandler = createStudioRequestHandler({
    ...requestOptions,
    requestShutdown: () => {
      void stop();
    },
  });

  async function startListener(): Promise<string> {
    if (server) return serverUrl!;
    requestHandler.prepare();
    await presentation?.prepare();

    const listenPort = port ?? Number(process.env.OMK_REPORT_PORT || DEFAULT_PORT);
    // host 默认 127.0.0.1（本机回环，默认安全）。容器／远程场景需显式对外暴露。
    const host = (hostOption || process.env.OMK_REPORT_HOST || '127.0.0.1').replace(/^\[|\]$/g, '');
    const urlHost = (value: string): string => value.includes(':') ? `[${value}]` : value;
    const boot = (candidatePort: number): Promise<Server> => new Promise((resolve, reject) => {
      const candidate = createServer(async (request, response) => {
        try {
          if (await presentation?.handle(request, response)) return;
          await requestHandler.handle(request, response);
        } catch {
          // 走到这里说明宿主自身故障（requestHandler 内部已兜住数据源错误），不得伪装成数据源不可用。
          if (!response.headersSent) response.writeHead(500, TEXT_HEADERS);
          response.end(STUDIO_INTERNAL_ERROR);
        }
      });
      candidate.once('error', reject);
      candidate.listen(candidatePort, host, () => resolve(candidate));
    });

    try {
      server = await boot(listenPort);
    } catch (error: unknown) {
      const formatted = formatListenError(listenPort, error);
      if (formatted) throw formatted;

      // EADDRINUSE：仅接管能够由 /health 认证为 OMK 的旧进程。
      const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
      const url = `http://${urlHost(probeHost)}:${listenPort}`;
      let isOmk = false;
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        const data = await response.json() as { service?: string };
        isOmk = data.service === 'omk';
      } catch { /* not reachable or not omk */ }

      if (isOmk) {
        try {
          await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
        } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          server = await boot(listenPort);
        } catch {
          throw new Error(`port ${listenPort} is still in use; close it manually and retry: lsof -ti:${listenPort} | xargs kill`);
        }
      } else {
        throw new Error(
          `port ${listenPort} is already in use by another process.\n` +
          `  inspect: lsof -i:${listenPort}\n` +
          `  release: lsof -ti:${listenPort} | xargs kill\n` +
          `  or pick another port: ${PORT_HINT}`
        );
      }
    }

    const address = server.address() as AddressInfo;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    serverUrl = `http://${urlHost(displayHost)}:${address.port}`;
    return serverUrl;
  }

  async function stopListener(): Promise<void> {
    if (!server) return;
    requestHandler.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverUrl = null;
    await presentation?.close();
  }

  function start(): Promise<string> {
    return serialize(async () => {
      try { return await startListener(); }
      catch (error) { await presentation?.close(); throw error; }
    });
  }

  function stop(): Promise<void> {
    return serialize(stopListener);
  }

  return {
    start,
    stop,
    getUrl: () => serverUrl,
  };
}

export type { ReportServer, ReportServerOptions } from './contracts.js';
