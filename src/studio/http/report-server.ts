import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReportServer, ReportServerOptions } from './contracts.js';
import { getErrorMessage } from './errors.js';
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

export function createReportServer(options: ReportServerOptions = {}): ReportServer {
  const {
    port,
    host: hostOption,
    ...requestOptions
  } = options;
  let server: Server | null = null;
  let serverUrl: string | null = null;
  const requestHandler = createStudioRequestHandler({
    ...requestOptions,
    requestShutdown: () => {
      if (server) server.close();
    },
  });

  async function start(): Promise<string> {
    if (server) return serverUrl!;
    requestHandler.prepare();

    const listenPort = port ?? Number(process.env.OMK_REPORT_PORT || DEFAULT_PORT);
    // host 默认 127.0.0.1（本机回环，默认安全）。容器／远程场景需显式对外暴露。
    const host = hostOption || process.env.OMK_REPORT_HOST || '127.0.0.1';
    const boot = (candidatePort: number): Promise<Server> => new Promise((resolve, reject) => {
      const candidate = createServer(requestHandler.handle);
      candidate.once('error', reject);
      candidate.listen(candidatePort, host, () => resolve(candidate));
    });

    try {
      server = await boot(listenPort);
    } catch (error: unknown) {
      const formatted = formatListenError(listenPort, error);
      if (formatted) throw formatted;

      // EADDRINUSE：仅接管能够由 /health 认证为 OMK 的旧进程。
      const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const url = `http://${probeHost}:${listenPort}`;
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
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    serverUrl = `http://${displayHost}:${address.port}`;
    return serverUrl;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    requestHandler.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverUrl = null;
  }

  return {
    start,
    stop,
    getUrl: () => serverUrl,
  };
}

export type { ReportServer, ReportServerOptions } from './contracts.js';
