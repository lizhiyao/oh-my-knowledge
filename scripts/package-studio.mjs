import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'src/studio/web');
const target = join(root, 'dist/studio/web');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(app, '.next'), join(target, '.next'), {
  recursive: true,
  filter: source => !['cache', 'types', 'diagnostics'].includes(basename(source)),
});
cpSync(join(app, 'next.config.mjs'), join(target, 'next.config.mjs'));
