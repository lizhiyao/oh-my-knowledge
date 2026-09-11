import { parseCliEvaluationRequest, type CliEvaluationParseInput, type CliEvaluationRequest } from '../../input-compilation/index.js';
import type { StoredCoreRunArtifacts } from '../../artifact-store/index.js';

/** Reuse captured host policy for every round; only the compared versions change. */
export function createEvolutionEvaluator(
  captured: CliEvaluationParseInput,
  execute: (request: CliEvaluationRequest) => Promise<StoredCoreRunArtifacts | undefined>,
): (control: string, treatment: string) => Promise<StoredCoreRunArtifacts> {
  return async (control, treatment) => {
    const request = parseCliEvaluationRequest({
      ...captured,
      explicitCliFlags: {
        ...captured.explicitCliFlags,
        control,
        treatment,
        'no-evidence': true,
        'no-serve': true,
        'report-only': true,
      },
    });
    const stored = await execute(request);
    if (!stored) throw new Error('Evolution evaluation did not persist a Core artifact chain.');
    return stored;
  };
}
