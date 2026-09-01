import { basename, dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { StoredCoreRunArtifacts } from '../eval-workflows/artifact-store/index.js';
import { projectCoreArtifactGraph } from '../eval-workflows/downstream-projections/index.js';
import { graphFileName } from '../measurement-artifacts/file-names.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';

function coreEvalGraphDirectory(outputDirectory: string): string {
  return basename(outputDirectory) === 'reports'
    ? join(dirname(outputDirectory), 'graphs', 'eval')
    : join(outputDirectory, 'graphs', 'eval');
}

/** Persists only the privacy-safe graph projection reconstructed from exact Core artifacts. */
export async function persistCoreArtifactGraph(input: Readonly<{
  source: Readonly<StoredCoreRunArtifacts>;
  outputDirectory: string;
  cwd: string;
}>): Promise<string> {
  const directory = coreEvalGraphDirectory(input.outputDirectory);
  await mkdir(directory, { recursive: true });
  const path = join(directory, graphFileName(input.source.manifest.runId));
  const graph = projectCoreArtifactGraph({
    source: input.source,
    cwd: input.cwd,
    generatedAt: input.source.manifest.createdAt,
  });
  writeJsonFileAtomic(path, graph);
  return path;
}
