import { resolve } from 'node:path';
import {
  resolveManagedDir,
  managedDir,
  loadAllManagedRecords,
  rebaselineManagedContentHash,
  probeSourceState,
} from '../../managed/index.js';
import type { ManagedArtifactRecord } from '../../managed/contracts.js';
import type { StoredCoreRunArtifacts } from '../../eval-workflows/artifact-store/index.js';
import { projectCoreManagedEvidence } from '../../eval-workflows/downstream-projections/index.js';
import {
  coreEvidenceTargetForContentHash,
  recordCoreEvalEvidenceForRecord,
} from '../../managed/evidence.js';

export interface EvolveOutcomeResult {
  name: string;
  contentHash: string;
  verdict: string;
}

export interface CoreEvolveOutcomeInput {
  source: Readonly<StoredCoreRunArtifacts>;
  bestRound: number;
  skillPath: string;
  skillDir: string;
  isDirectorySkill: boolean;
  dir?: string;
}

function findRecordBySource(
  records: readonly ManagedArtifactRecord[],
  skillPath: string,
  skillDir: string,
  isDirectorySkill: boolean,
): ManagedArtifactRecord | undefined {
  const fileTarget = resolve(skillPath);
  const directoryTarget = resolve(skillDir);
  return records.find((record) => {
    if (record.source.sourceKind !== 'file') return false;
    const locator = resolve(record.source.locator);
    if (isDirectorySkill) {
      return (record.source.isDirectorySkill && locator === directoryTarget)
        || (!record.source.isDirectorySkill && locator === fileTarget);
    }
    return !record.source.isDirectorySkill && locator === fileTarget;
  });
}

/** Records only authenticated Core evidence for the exact evolved source digest. */
export function recordCoreEvolveOutcome(
  input: Readonly<CoreEvolveOutcomeInput>,
): EvolveOutcomeResult | null {
  if (input.bestRound <= 0) return null;
  const directory = input.dir ?? resolveManagedDir(managedDir());
  const record = findRecordBySource(
    loadAllManagedRecords(directory),
    input.skillPath,
    input.skillDir,
    input.isDirectorySkill,
  );
  if (record === undefined) return null;
  const probe = probeSourceState(record);
  if (!probe.reachable || probe.hash === undefined) return null;
  const projection = projectCoreManagedEvidence(input.source);
  if (coreEvidenceTargetForContentHash(projection, probe.hash) === undefined) return null;
  if (!rebaselineManagedContentHash(directory, record.id, probe.hash)) return null;
  const written = recordCoreEvalEvidenceForRecord(
    projection,
    record.id,
    probe.hash,
    { dir: directory },
  );
  if (written === undefined) return null;
  const verdict = projection.decision?.decisionStatus === 'decided'
    ? projection.decision.verdict
    : 'UNKNOWN';
  return { name: written.name, contentHash: written.contentHash, verdict };
}
