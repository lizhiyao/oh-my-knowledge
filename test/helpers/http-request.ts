import http from 'node:http';

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  requestEnded: boolean;
}

export function request(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    endBody?: boolean;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
        requestEnded: req.writableEnded,
      }));
    });
    req.on('error', reject);
    if (options.endBody === false) req.setTimeout(2000, () => req.destroy(new Error('Oversized body was not rejected before client EOF.')));
    if (options.body !== undefined) req.write(options.body);
    if (options.endBody !== false) req.end();
  });
}
