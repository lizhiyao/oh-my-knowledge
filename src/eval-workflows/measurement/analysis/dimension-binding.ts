import { canonicalizeJson } from '../../../eval-core/contracts/index.js';

type DimensionBinding = Readonly<{
  dimensionId: string;
  metricId: string;
  sourceAnalysisResultId: string;
}>;

export function assertStableBinding(
  entries: readonly DimensionBinding[],
  keyField: keyof DimensionBinding,
  issue: (path: Array<string | number>, message: string) => void,
): void {
  const bindings = new Map<string, string>();
  for (const entry of entries) {
    const binding = canonicalizeJson({
      dimensionId: entry.dimensionId,
      metricId: entry.metricId,
      sourceAnalysisResultId: entry.sourceAnalysisResultId,
    });
    const previous = bindings.get(entry[keyField]);
    if (previous !== undefined && previous !== binding) {
      issue(['groups'], `Dimension ${keyField} binding must remain stable across groups.`);
      return;
    }
    bindings.set(entry[keyField], binding);
  }
}
