import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { coreRunArtifactDirectoryName, type StoredCoreRunArtifacts } from '../artifact-store/index.js';
import { projectCoreArtifactGraph } from '../downstream-projections/index.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';

/** Persists only the privacy-safe graph projection reconstructed from exact Core artifacts. */
export async function persistCoreArtifactGraph(input: Readonly<{
  source: Readonly<StoredCoreRunArtifacts>;
  outputDirectory: string;
  cwd: string;
}>): Promise<string> {
  const directory = join(
    input.outputDirectory,
    coreRunArtifactDirectoryName(input.source.manifest.runId),
    'derived',
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'graph.json');
  const graph = projectCoreArtifactGraph({
    source: input.source,
    cwd: input.cwd,
    generatedAt: input.source.manifest.createdAt,
  });
  writeJsonFileAtomic(path, graph);
  return path;
}
