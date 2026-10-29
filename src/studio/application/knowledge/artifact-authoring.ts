import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { CarrierLibrary } from '../../../knowledge/artifacts/authoring/carrier-library.js';
import { executeCarrierAuthoring, parseCarrierAuthoringRequest } from '../../../knowledge/artifacts/authoring/application.js';

const workspaceSelection = z.object({ workspace: z.string().trim().min(1) }).passthrough();

/** Studio owns request/workspace selection; shared knowledge use cases own carrier rules. */
export function executeArtifactAuthoring(input: unknown, lang: 'zh' | 'en', signal?: AbortSignal) {
  const { workspace, ...fields } = workspaceSelection.parse(input);
  const request = parseCarrierAuthoringRequest(fields);
  signal?.throwIfAborted();
  return executeCarrierAuthoring(request, {
    library: new CarrierLibrary(workspace), knowledge: createLocalKnowledgeApplication(workspace),
    id: randomUUID, now: () => new Date().toISOString(),
  }, lang, signal);
}
