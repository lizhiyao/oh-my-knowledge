import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ReportServer, ReportServerAddresses, ReportServerOptions } from './contracts.js';
import type { StudioAppHost } from './app-host.js';
import { getErrorMessage, STUDIO_INTERNAL_ERROR, TEXT_HEADERS } from './errors.js';
import { createStudioRequestHandler } from './request-handler.js';
import { projectServerAddresses } from './server-addresses.js';

const DEFAULT_PORT = 7799;
const PORT_HINT = `OMK_REPORT_PORT=${DEFAULT_PORT} omk eval ...`;
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "base-uri 'none'; object-src 'none'",
});

function trustedHost(request: IncomingMessage, listenHost: string, boundHost: string): boolean {
  const authority = request.headers.host;
  if (!authority || !/^(?:\[[\da-f:.]+\]|[\da-z._-]+)(?::\d+)?$/i.test(authority)) return false;
  // Node keeps only the first Host value; reject ambiguous authorities as well.
  if (request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'host').length !== 1) return false;
  try {
    const hostname = new URL(`http://${authority}`).hostname;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return true;
    const wildcard = listenHost === '0.0.0.0' || listenHost === '::';
    // Explicit network exposure still accepts literal LAN IPs, never arbitrary DNS names.
    if (wildcard) return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
    const configured = new URL(`http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}`).hostname;
    const bound = isIP(boundHost) !== 0
      ? new URL(`http://${boundHost.includes(':') ? `[${boundHost}]` : boundHost}`).hostname : undefined;
    return hostname === configured || hostname === bound;
  } catch {
    return false;
  }
}

// Returns Error to throw, or null only for EADDRINUSE, where the caller checks
// explicit takeover permission. Splits occupancy from permission and
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

  if (errno !== 'EADDRINUSE') {
    return new Error(
      `cannot bind port ${port}: ${errno ?? 'unknown error'} (${getErrorMessage(error)}).\n` +
      `  pick another port: ${PORT_HINT}`
    );
  }

  return null;
}

export function createReportServer(options: ReportServerOptions = {}, appHost?: StudioAppHost): ReportServer {
  const {
    port,
    host: hostOption,
    takeover = false,
    ...requestOptions
  } = options;
  let server: Server | null = null;
  let serverAddresses: ReportServerAddresses | null = null;
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
    if (server) return serverAddresses!.url;
    await appHost?.prepare();

    const listenPort = port ?? Number(process.env.OMK_REPORT_PORT || DEFAULT_PORT);
    // host 默认 127.0.0.1（本机回环，默认安全）。容器／远程场景需显式对外暴露。
    const host = (hostOption || process.env.OMK_REPORT_HOST || '127.0.0.1').replace(/^\[|\]$/g, '');
    const interfaces = networkInterfaces();
    const urlHost = (value: string): string => value.includes(':') ? `[${value}]` : value;
    const boot = (candidatePort: number): Promise<Server> => new Promise((resolve, reject) => {
      const candidate = createServer(async (request, response) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
        if (!trustedHost(request, host, (candidate.address() as AddressInfo).address)) {
          response.writeHead(403, { ...TEXT_HEADERS, Connection: 'close' });
          response.end('studio_host_not_trusted');
          return;
        }
        try {
          if (await appHost?.handle(request, response)) return;
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
      if (!takeover) {
        throw new Error(
          `port ${listenPort} is already in use; the existing service was not stopped.\n` +
          '  choose a free --port, or explicitly use omk studio --takeover with the same --host and --port to replace an OMK service.',
        );
      }

      // 显式 EADDRINUSE 接管：不跟随重定向，不向未通过同地址 /health 验证的服务发关闭请求。
      const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
      const url = `http://${urlHost(probeHost)}:${listenPort}`;
      let isOmk = false;
      try {
        const response = await fetch(`${url}/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
        const data = await response.json() as { ok?: boolean; service?: string };
        isOmk = response.status === 200 && data.ok === true && data.service === 'omk';
      } catch { /* not reachable or not omk */ }

      if (isOmk) {
        try {
          const response = await fetch(`${url}/api/shutdown`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000) });
          const data = await response.json() as { ok?: boolean };
          if (response.status !== 200 || data.ok !== true) throw new Error('shutdown not acknowledged');
        } catch {
          throw new Error(`OMK at ${url} did not acknowledge shutdown; it was not replaced. Stop it manually or choose another --port.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          server = await boot(listenPort);
        } catch {
          throw new Error(`port ${listenPort} is still in use after the OMK shutdown request; stop it manually or choose another --port.`);
        }
      } else {
        throw new Error(
          `port ${listenPort} is already in use; the service at ${url} could not be verified as OMK and was not stopped.\n` +
          '  inspect the listener or choose another --port.',
        );
      }
    }

    const address = server.address() as AddressInfo;
    serverAddresses = projectServerAddresses(address, interfaces);
    return serverAddresses.url;
  }

  async function stopListener(): Promise<void> {
    if (!server) return;
    requestHandler.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverAddresses = null;
    await appHost?.close();
  }

  function start(): Promise<string> {
    return serialize(async () => {
      try { return await startListener(); }
      catch (error) { await appHost?.close(); throw error; }
    });
  }

  function stop(): Promise<void> {
    return serialize(stopListener);
  }

  return {
    start,
    stop,
    getUrl: () => serverAddresses?.url ?? null,
    getAddresses: () => serverAddresses ? { ...serverAddresses, networkUrls: [...serverAddresses.networkUrls] } : null,
  };
}
