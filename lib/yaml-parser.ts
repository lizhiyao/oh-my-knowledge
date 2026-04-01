/**
 * YAML parsing via js-yaml.
 */

import yaml from 'js-yaml';

interface YamlErrorLike {
  mark?: { line: number };
  reason?: string;
  message?: string;
}

export function parseYaml(text: string): unknown {
  try {
    return yaml.load(text);
  } catch (err: unknown) {
    const yamlError = (typeof err === 'object' && err !== null ? err : {}) as YamlErrorLike;
    const line = yamlError.mark ? ` at line ${yamlError.mark.line + 1}` : '';
    throw new Error(`YAML parse error${line}: ${yamlError.reason || yamlError.message || 'unknown error'}`);
  }
}
