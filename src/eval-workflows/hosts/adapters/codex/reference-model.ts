import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'smol-toml';
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
  let model: unknown;
  try {
    const config: Record<string, unknown> = parse(readFileSync(configPath, 'utf8'));
    // Profile selection is not silently approximated with the top-level model.
    const profile = config.profile;
    if (profile !== undefined) {
      const profiles = config.profiles;
      if (typeof profile !== 'string' || !profiles || typeof profiles !== 'object'
          || Array.isArray(profiles)) throw new Error('Invalid profile');
      const selected = (profiles as Record<string, unknown>)[profile];
      if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
        throw new Error('Missing profile');
      }
      model = 'model' in selected ? selected.model : config.model;
    } else model = config.model;
  } catch {
    // TOML errors can contain credentials and local paths. Keep both out of diagnostics.
    throw new TypeError('Cannot resolve Codex default model; provide model or a readable, valid modelConfigPath.');
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('Codex config has no non-empty default model; provide model explicitly.');
  }
  return model;
}
