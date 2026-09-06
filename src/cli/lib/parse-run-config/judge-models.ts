import { CliExit } from '../cli-exit.js';
import type { JudgeConfig } from '../../../eval-workflows/instruments/contracts/config.js';
import { parseJudgeModelsArg } from '../../../eval-workflows/inputs/judge-models.js';

export function parseJudgeModelsArgOrExit(raw: string): JudgeConfig[] {
  try {
    return parseJudgeModelsArg(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    throw new CliExit(2);
  }
}
