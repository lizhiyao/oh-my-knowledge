/**
 * YAML parsing via js-yaml.
 */

import yaml from 'js-yaml';

export function parseYaml(text: string): unknown {
  try {
    return yaml.load(text);
  } catch (err: any) {
    const line = err.mark ? ` at line ${err.mark.line + 1}` : '';
    throw new Error(`YAML parse error${line}: ${err.reason || err.message}`);
  }
}
