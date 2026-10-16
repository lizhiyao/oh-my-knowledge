import { createHash } from 'node:crypto';

/** Frozen first-party budget contract facts. Pure semantics; no executor, credentials, dispatch or price quote. */
export const OPENAI_TOKEN_BUDGET_EVIDENCE = Object.freeze({
  evidenceVersion: 'omk-openai-capture-budget-evidence/v1', retrievedOn: '2026-10-16',
  model: 'gpt-5.4-2026-03-05', contextTokens: 1_050_000, maxOutputTokens: 128_000,
  modelSource: 'https://developers.openai.com/api/docs/models/gpt-5.4',
  modelFacts: 'The model page lists this snapshot, a 1050000 context window, 128000 output maximum, Chat Completions and structured outputs.',
  capSource: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
  capFacts: 'max_completion_tokens bounds completion generation, including visible and reasoning tokens.',
  accountingSource: 'https://developers.openai.com/api/docs/guides/token-counting',
  accountingFacts: 'Completion usage and output ceilings include non-visible generated tokens.',
  reservationRule: 'whole documented context capacity plus explicit max_completion_tokens; no predicted outputs/tools/multiple choices',
});
export const OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(OPENAI_TOKEN_BUDGET_EVIDENCE)).digest('hex')}`;
export interface BudgetProfile {
  profileId: string; authority: 'official-contract' | 'loopback-test-only'; evidenceDigest: string;
  inputUpperBound: number; outputUpperBound: number;
}

/** Only exact API identities have a hard-token profile; CLI byte bounds cannot establish one. */
export function resolveTokenBudgetProfile(id: string, model: string, endpoint: string): BudgetProfile {
  if (id === 'openai-gpt54-snapshot-context/v1' && model === OPENAI_TOKEN_BUDGET_EVIDENCE.model
    && endpoint === 'https://api.openai.com/v1/chat/completions') {
    return { profileId: id, authority: 'official-contract', evidenceDigest: OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST,
      inputUpperBound: OPENAI_TOKEN_BUDGET_EVIDENCE.contextTokens, outputUpperBound: OPENAI_TOKEN_BUDGET_EVIDENCE.maxOutputTokens };
  }
  const url = new URL(endpoint);
  if (id === 'loopback-test/v1' && model === 'authored-loopback-test' && endpoint === url.href
    && url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1/chat/completions') {
    return { profileId: id, authority: 'loopback-test-only', evidenceDigest: 'sha256:' + '0'.repeat(64), inputUpperBound: 1024, outputUpperBound: 64 };
  }
  throw new Error('No verified budget profile for this exact endpoint/model/protocol; no request allowed.');
}
