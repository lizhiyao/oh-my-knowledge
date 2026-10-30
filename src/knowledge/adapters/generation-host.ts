import { createHash } from 'node:crypto';
import type { ExecutorArchiveEvidence, ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import { canonicalJson } from '../store.js';
import { configuredKnowledgeGenerationModel } from './generation-executor.js';

export const KNOWLEDGE_GENERATION_ENVIRONMENT_POLICY = Object.freeze({
  policyVersion: 'knowledge-generation-host-environment/v1',
  omittedKeys: Object.freeze(['CODEX_TOOL_CALL_ID']),
  keyOrder: 'unicode-code-unit-ascending',
  preserved: 'Every other original key and value; no credential, endpoint, PATH or runtime substitution.',
});

/** Tracking IDs change across Desktop tool calls; neither the proof nor the child receives that one key. */
export function knowledgeGenerationEnvironment(environment: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze(Object.fromEntries(Object.keys(environment).sort().filter(key => key !== 'CODEX_TOOL_CALL_ID')
    .map(key => [key, environment[key]])) as NodeJS.ProcessEnv);
}

function hostEvidence(evidence: ExecutorArchiveEvidence): ExecutorArchiveEvidence {
  const proof = evidence.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('A local generation host requires an object producer proof.');
  return { ...evidence, producerRevision: `sha256:${createHash('sha256').update(canonicalJson({ hostPolicy: KNOWLEDGE_GENERATION_ENVIRONMENT_POLICY,
    underlyingProducerId: evidence.producerId, underlyingProducerRevision: evidence.producerRevision })).digest('hex')}`,
    proof: { ...proof, hostEnvironmentPolicy: KNOWLEDGE_GENERATION_ENVIRONMENT_POLICY,
      underlyingProducerRevision: evidence.producerRevision } };
}

/** One normal CLI/Studio host policy; frozen historical studies retain their own original environment. */
export function createLocalKnowledgeGenerationModel(executor: string, model: string,
  createProducer: (environment: NodeJS.ProcessEnv) => ExecutorArchiveProducer, environment: NodeJS.ProcessEnv = process.env, timeoutMs = 300_000) {
  const original = createProducer(knowledgeGenerationEnvironment(environment));
  const producer: ExecutorArchiveProducer = {
    assertCapabilities: (name, input) => original.assertCapabilities(name, input),
    inspect: (name, input) => hostEvidence(original.inspect(name, input)),
    configure(name, input, beforeDispatch) {
      const configured = original.configure(name, input, beforeDispatch);
      return { evidence: hostEvidence(configured.evidence), execute: actual => configured.execute(actual) };
    },
  };
  return configuredKnowledgeGenerationModel(executor, model, producer, timeoutMs);
}
