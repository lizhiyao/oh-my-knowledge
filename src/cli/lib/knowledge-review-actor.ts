import type { KnowledgeActor } from '../../knowledge/contracts.js';

/** Launcher-provided attribution for new review writes, not identity authentication. */
export function knowledgeReviewCliActor(environment: NodeJS.ProcessEnv): KnowledgeActor | undefined {
  const thread = environment.CODEX_THREAD_ID;
  if (environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== 'Codex Desktop'
    || !thread || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)) return undefined;
  return { actorKind: 'agent', actorId: `codex:${thread}`, executionRef: `codex-thread:${thread}` };
}
