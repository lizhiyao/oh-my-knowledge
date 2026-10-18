// Internal repository tool host. Not a public SDK export or an oclif command.
import { createRequire } from 'node:module';
import { WINDOW_EXTRACTION_WIRE_IDENTITY } from '../../knowledge/extraction/model-wire.js';
// Resolve metadata from the actual validator module's location, including nested installations.
const validatorRequire = createRequire(new URL('../../knowledge/extraction/model-wire.js', import.meta.url));
const ajvVersion = (validatorRequire('ajv/package.json') as { version: string }).version;
if (typeof ajvVersion !== 'string' || !ajvVersion.trim()) throw new Error('Actual Ajv version is unavailable.');
export const CAPTURE_VALIDATOR_IDENTITY = Object.freeze({ zod: WINDOW_EXTRACTION_WIRE_IDENTITY.zodVersion, ajv: ajvVersion });
export { createExecutor, assertExecutorInputCapabilities, getExecutorCapabilities } from '../../executors/index.js';
export { buildOpenAiChatRequest, OPENAI_CHAT_REQUEST_VERSION } from '../../executors/openai/request.js';
export { OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION } from '../../executors/openai/api.js';
export { OPENAI_TOKEN_BUDGET_EVIDENCE, OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST, resolveTokenBudgetProfile } from '../../executors/contracts/token-budget.js';
export { checkWindowExtractionResponse } from '../../knowledge/extraction/window-proposals.js';
export { decodeWindowExtractionWire, WINDOW_EXTRACTION_WIRE_ID, WINDOW_EXTRACTION_WIRE_IDENTITY,
  WINDOW_EXTRACTION_WIRE_SCHEMA } from '../../knowledge/extraction/model-wire.js';
