import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexModelSuggestion {
  model: string;
  fromConfig: boolean;
  configPath?: string;
}

const CODEX_MODEL_PLACEHOLDER = '<codex-model>';

function parseTopLevelCodexModel(configText: string): string | null {
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return null;
    const match = line.match(/^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/);
    const model = match?.[1] ?? match?.[2];
    if (model) return model;
  }
  return null;
}

export function getCodexModelSuggestion(env: NodeJS.ProcessEnv = process.env): CodexModelSuggestion {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');
  if (existsSync(configPath)) {
    try {
      const model = parseTopLevelCodexModel(readFileSync(configPath, 'utf-8'));
      if (model) return { model, fromConfig: true, configPath };
    } catch { /* best-effort hint only */ }
  }
  return { model: CODEX_MODEL_PLACEHOLDER, fromConfig: false, configPath };
}

export function codexModelHint(lang: 'zh' | 'en', env: NodeJS.ProcessEnv = process.env): string {
  const suggestion = getCodexModelSuggestion(env);
  if (suggestion.fromConfig) {
    return lang === 'zh'
      ? `已按本机 Codex 配置 model=${suggestion.model} 填入。`
      : `Filled from local Codex config model=${suggestion.model}.`;
  }
  return lang === 'zh'
    ? `把 ${CODEX_MODEL_PLACEHOLDER} 换成本机 Codex 可用模型；可查看 ${suggestion.configPath} 的 model。`
    : `Replace ${CODEX_MODEL_PLACEHOLDER} with a model your local Codex can run; check model in ${suggestion.configPath}.`;
}

export function codexModelFlagValue(env: NodeJS.ProcessEnv = process.env): string {
  return getCodexModelSuggestion(env).model;
}

export function codexExecutorFlags(env: NodeJS.ProcessEnv = process.env): string {
  return `--executor codex --model ${codexModelFlagValue(env)}`;
}
