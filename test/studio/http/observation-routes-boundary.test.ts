import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio observation route boundary', () => {
  it('keeps inbox, debugger, and review-state behavior out of request composition', () => {
    const composition = readFileSync('src/studio/http/request-handler.ts', 'utf8');

    expect(composition).toContain('createObservationRoutes');
    for (const forbidden of [
      'buildObservationInboxViewModel',
      'buildKnowledgeDebuggerViewModel',
      'renderObservationInboxPage',
      'renderKnowledgeDebuggerPage',
      'loadObservationSourceRecordArchive',
      'updateObservationReviewState',
      '/api/observe-inbox/review-state',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });

  it('keeps generic request validation independent from domain code', () => {
    const requestErrors = readFileSync('src/studio/http/request-errors.ts', 'utf8');

    expect(requestErrors).not.toMatch(/\.\.\/.*(?:observability|diagnosis|doctor|managed|measurement-artifacts)/);
    expect(requestErrors).not.toContain('ObservationReviewState');
  });
});
