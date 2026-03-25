/**
 * YAML parsing via js-yaml.
 */

import yaml from 'js-yaml';

export function parseYaml(text) {
  return yaml.load(text);
}
