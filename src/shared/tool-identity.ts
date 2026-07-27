export interface NormalizedToolIdentity {
  /** Source-neutral name consumed by assertions and aggregate reports. */
  name: string;
  /** Runtime-native name, retained when normalization changes it. */
  sourceName?: string;
  namespace?: string;
  provider?: string;
  displayName?: string;
}

export interface ToolIdentityInput {
  sourceName: string;
  namespace?: string;
  provider?: string;
  /** Runtime-authoritative leaf name, such as an MCP end event's tool. */
  authoritativeName?: string;
}

const BUILTIN_ALIASES = new Map<string, string>([
  ['bash', 'Bash'],
  ['shell', 'Bash'],
  ['exec_command', 'Bash'],
  ['command_execution', 'Bash'],
  ['read', 'Read'],
  ['file_read', 'Read'],
  ['grep', 'Grep'],
  ['edit', 'Edit'],
  ['apply_patch', 'Edit'],
  ['file_change', 'Edit'],
  ['write', 'Write'],
  ['file_write', 'Write'],
  ['view_image', 'ViewImage'],
  ['viewimage', 'ViewImage'],
  ['write_stdin', 'WriteStdin'],
  ['writestdin', 'WriteStdin'],
  ['web_search', 'WebSearch'],
  ['websearch', 'WebSearch'],
]);

/**
 * Normalize runtime-specific tool labels into one comparison namespace while
 * retaining source identity for audit and future protocol migrations.
 */
export function normalizeToolIdentity(input: ToolIdentityInput): NormalizedToolIdentity {
  const sourceName = input.sourceName.trim() || 'unknown';
  const namespace = nonEmpty(input.namespace) ?? inferredMcpNamespace(sourceName);
  const authoritativeName = nonEmpty(input.authoritativeName);
  const isMcp = Boolean(
    authoritativeName
    || sourceName.startsWith('mcp__')
    || namespace?.startsWith('mcp__'),
  );

  if (isMcp) {
    const sourceLeaf = sourceName.split('__').filter(Boolean).at(-1) ?? sourceName;
    const leaf = authoritativeName ?? sourceLeaf;
    const provider = nonEmpty(input.provider) ?? providerFromNamespace(namespace);
    const name = provider && !leaf.startsWith(`${provider}.`)
      ? `${provider}.${leaf}`
      : leaf;
    return {
      name,
      ...(sourceName !== name ? { sourceName } : {}),
      ...(namespace ? { namespace } : {}),
      ...(provider ? { provider } : {}),
      displayName: name,
    };
  }

  if (namespace) {
    const name = sourceName.startsWith(`${namespace}.`)
      ? sourceName
      : `${namespace}.${sourceName}`;
    return {
      name,
      ...(sourceName !== name ? { sourceName } : {}),
      namespace,
      provider: nonEmpty(input.provider) ?? namespace,
      displayName: name,
    };
  }

  const name = BUILTIN_ALIASES.get(sourceName.toLowerCase()) ?? sourceName;
  return {
    name,
    ...(sourceName !== name ? { sourceName } : {}),
  };
}

function inferredMcpNamespace(sourceName: string): string | undefined {
  const parts = sourceName.split('__').filter(Boolean);
  return parts[0] === 'mcp' && parts.length > 2
    ? parts.slice(0, -1).join('__')
    : undefined;
}

function providerFromNamespace(namespace: string | undefined): string | undefined {
  if (!namespace) return undefined;
  const parts = namespace.replace(/^mcp__/, '').split('__').filter(Boolean);
  // codex_apps is a transport namespace; the following component is the
  // actual connector/provider and matches Codex MCP end-event metadata.
  if (parts[0] === 'codex_apps' && parts.length > 1) parts.shift();
  return parts.length > 0 ? parts.join('.') : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
