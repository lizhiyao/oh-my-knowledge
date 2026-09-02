export type AnalysisResamplingUnit = 'sample' | 'paired-block' | 'cluster' | 'run';

export interface AnalysisResamplingUnitRow {
  readonly targetId: string;
  readonly sampleId: string;
  readonly samplingUnitIds: {
    readonly pairingBlockId?: string;
    readonly clusterId?: string;
  };
}

export function countAnalysisResamplingUnits(
  resamplingUnit: AnalysisResamplingUnit,
  rows: readonly AnalysisResamplingUnitRow[],
  requiredPairedTargetIds: readonly string[] = [],
): number {
  if (resamplingUnit === 'run') return rows.length > 0 ? 1 : 0;
  if (resamplingUnit === 'paired-block') {
    const targetsByBlock = new Map<string, Set<string>>();
    for (const row of rows) {
      const blockId = row.samplingUnitIds.pairingBlockId;
      if (blockId === undefined) continue;
      const targets = targetsByBlock.get(blockId) ?? new Set<string>();
      targets.add(row.targetId);
      targetsByBlock.set(blockId, targets);
    }
    return [...targetsByBlock.values()].filter((targets) => (
      requiredPairedTargetIds.every((targetId) => targets.has(targetId))
    )).length;
  }
  const ids = rows.flatMap((row) => {
    if (resamplingUnit === 'sample') return [row.sampleId];
    return row.samplingUnitIds.clusterId === undefined
      ? []
      : [row.samplingUnitIds.clusterId];
  });
  return new Set(ids).size;
}
