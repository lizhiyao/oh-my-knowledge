import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  NodeCliProductionCompositionError,
  type NodeEvaluationEnvironment,
  type ClassifiedEnvironmentEntry,
} from '../../eval-workflows/hosts/application.js';

const CREDENTIAL_ENVIRONMENT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
]);

const SECRET_TAINT_ENVIRONMENT = new Set([
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
]);

const EFFECT_LOCATOR_ENVIRONMENT = new Set([
  'ALL_PROXY',
  'CODEX_HOME',
  'CURL_CA_BUNDLE',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

const BEHAVIOR_ENVIRONMENT = new Set([
  'LANG',
  'LC_ALL',
  'NO_COLOR',
]);

export function classifyNodeCliEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, ClassifiedEnvironmentEntry>> {
  const keys = new Set([
    ...CREDENTIAL_ENVIRONMENT,
    ...EFFECT_LOCATOR_ENVIRONMENT,
    ...BEHAVIOR_ENVIRONMENT,
  ]);
  return Object.freeze(Object.fromEntries([...keys].sort().flatMap((key) => {
    const value = environment[key];
    if (value === undefined) return [];
    const identity: ClassifiedEnvironmentEntry['identity'] = CREDENTIAL_ENVIRONMENT.has(key)
      ? { identityKind: 'credential' }
      : EFFECT_LOCATOR_ENVIRONMENT.has(key)
        ? { identityKind: 'effect-locator' }
        : { identityKind: 'behavior', value };
    return [[key, Object.freeze({
      value,
      identity,
      ...(SECRET_TAINT_ENVIRONMENT.has(key) ? { outputTaint: 'secret' as const } : {}),
    })]];
  })));
}

async function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => (
      join(directory, command)
    ));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the explicit PATH snapshot.
    }
  }
  throw new NodeCliProductionCompositionError(
    'NODE_CLI_EXECUTABLE_UNAVAILABLE',
    `执行器「${command}」在当前 PATH 中不可用。`,
  );
}

function requiredCredential(
  environment: NodeJS.ProcessEnv,
  key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY',
): string {
  const value = environment[key]?.trim();
  if (value !== undefined && value !== '') return value;
  throw new NodeCliProductionCompositionError(
    'NODE_CLI_CREDENTIAL_MISSING',
    `执行器需要环境变量 ${key}。`,
  );
}

export function captureNodeCliEvaluationEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeEvaluationEnvironment {
  const captured = Object.freeze({ ...environment });
  return Object.freeze({
    environment: captured,
    classifiedEnvironment: classifyNodeCliEnvironment(captured),
    resolveExecutable: (command: string) => resolveExecutable(command, captured),
    requiredCredential: (key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY') => requiredCredential(captured, key),
  });
}
