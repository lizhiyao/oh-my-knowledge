import { parse } from 'smol-toml';

/** How a Codex `config.toml` resolved its model; failure detail stays out of the result. */
export type CodexConfigModelResolution =
  | { readonly status: 'resolved'; readonly model: string }
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' };

function asTable(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveModel(value: unknown): CodexConfigModelResolution {
  return typeof value === 'string' && value.trim() !== ''
    ? { status: 'resolved', model: value }
    : { status: 'absent' };
}

/**
 * Resolves the model a Codex config applies: the one of the profile named by top-level
 * `profile`, otherwise the top-level `model`. TOML parser errors can carry credentials and
 * local paths, so malformed input reports `invalid` instead of throwing; callers decide
 * whether that fails closed or degrades.
 */
export function resolveCodexConfigModel(configText: string): CodexConfigModelResolution {
  let config: Record<string, unknown> | null;
  try {
    config = asTable(parse(configText));
  } catch {
    return { status: 'invalid' };
  }
  if (config === null) return { status: 'invalid' };

  const profile = config.profile;
  if (profile === undefined) return resolveModel(config.model);
  // A declared but unresolvable profile is not silently approximated with the top-level model.
  if (typeof profile !== 'string') return { status: 'invalid' };
  const profiles = asTable(config.profiles);
  const selected = profiles === null ? null : asTable(profiles[profile]);
  if (selected === null) return { status: 'invalid' };
  return 'model' in selected ? resolveModel(selected.model) : resolveModel(config.model);
}
