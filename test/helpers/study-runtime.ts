import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EXTRACTION_STUDY_DEPENDENCY_SEEDS } from '../../src/knowledge/adapters/study-host.js';

/** A private physical installation, never symlinked to or mutating the live/frozen host. */
export function copyStudyRuntime(repository: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  cpSync(join(repository, 'dist'), join(destination, 'dist'), { recursive: true,
    filter: path => !path.startsWith(join(repository, 'dist/studio/web')) });
  writeFileSync(join(destination, 'package.json'), '{"type":"module"}');
  const pending = EXTRACTION_STUDY_DEPENDENCY_SEEDS.map(name => ({ require: createRequire(import.meta.url), name: String(name), install: join(destination, 'node_modules') }));
  const copied = new Set<string>();
  for (const item of pending) {
    let directory = dirname(realpathSync(item.require.resolve(item.name)));
    while (!existsSync(join(directory, 'package.json')) || JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name !== item.name) {
      const parent = dirname(directory); if (parent === directory) throw new Error('Fixture dependency manifest unavailable.'); directory = parent;
    }
    const target = join(item.install, item.name); if (copied.has(target)) continue; copied.add(target);
    cpSync(directory, target, { recursive: true, filter: path => !path.startsWith(join(directory, 'node_modules')) });
    const manifest = join(directory, 'package.json'), data = JSON.parse(readFileSync(manifest, 'utf8'));
    // Nested resolution preserves the real package/version selected by each physical parent.
    for (const name of Object.keys(data.dependencies ?? {})) pending.push({ require: createRequire(manifest), name, install: join(target, 'node_modules') });
  }
}
