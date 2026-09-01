import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio conversation route boundary', () => {
  it('keeps conversation rendering and live trajectory state out of composition', () => {
    const composition = readFileSync('src/studio/http/request-handler.ts', 'utf8');

    expect(composition).toContain('createConversationRoutes');
    for (const forbidden of [
      'buildConversationActivitySnapshot',
      'buildConversationDetailActivitySnapshot',
      'renderConversationDetailPage',
      'renderConversationIndexPage',
      'observeTaskTrajectory(',
      'event: trajectory',
      ': keepalive',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });

  it('keeps the route family independent from listener and global composition', () => {
    const routes = readFileSync('src/studio/http/routes/conversations.ts', 'utf8');

    expect(routes).not.toContain('report-server');
    expect(routes).not.toContain('request-handler');
    expect(routes).not.toContain('createServer');
    expect(routes).not.toContain('.listen(');
  });
});
