import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveCodexConfigModel } from '../../../../executors/openai/codex/config.js';
import type { CreateCodexCliReferenceExecutorInput } from './reference-executor.js';

/** Read once before identity sealing; never pass local settings through to the child. */
export function resolveCodexReferenceModel(
  input: Readonly<CreateCodexCliReferenceExecutorInput>,
): string {
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      throw new TypeError('Codex CLI reference Executor requires a non-empty model.');
    }
    return input.model;
  }
  const codexHome = input.environment?.CODEX_HOME?.value
    ?? (input.environment?.HOME?.value === undefined
      ? process.env.CODEX_HOME || join(homedir(), '.codex')
      : join(input.environment.HOME.value, '.codex'));
  const configPath = input.modelConfigPath ?? join(codexHome, 'config.toml');
  if (typeof configPath !== 'string' || !isAbsolute(configPath) || configPath.includes('\0')) {
    throw new TypeError('Codex default model requires an absolute modelConfigPath or home directory.');
  }
  let configText: string;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch {
    // TOML errors can contain credentials and local paths. Keep both out of diagnostics.
    throw new TypeError('Cannot resolve Codex default model; provide model or a readable, valid modelConfigPath.');
  }
  const resolution = resolveCodexConfigModel(configText);
  if (resolution.status === 'invalid') {
    throw new TypeError('Cannot resolve Codex default model; provide model or a readable, valid modelConfigPath.');
  }
  if (resolution.status === 'absent') {
    throw new TypeError('Codex config has no non-empty default model; provide model explicitly.');
  }
  return resolution.model;
}
