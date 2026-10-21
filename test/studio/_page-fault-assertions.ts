import assert from 'node:assert/strict';

/** Real production HTML, rather than a text error with the right status or a streamed 200. */
export async function assertPageFault(response: Response, code: string): Promise<string> {
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const html = await response.text();
  assert.match(html, /<h1 id="studio-page-fault-title">/);
  assert.ok(html.includes(`<code>${code}</code>`), `missing fault identity ${code}`);
  assert.doesNotMatch(html, /token=secret|secret=token|EACCES|ENOTDIR|\/private\/(?:token|catalog|path)/);
  return html;
}
