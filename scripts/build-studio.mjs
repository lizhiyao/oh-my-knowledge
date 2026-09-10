import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'src/studio/web');
const result = spawnSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build', app, '--webpack'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const target = join(root, 'dist/studio/web');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(app, '.next'), join(target, '.next'), {
  recursive: true,
  filter: source => !['cache', 'types', 'diagnostics'].includes(basename(source)),
});
cpSync(join(app, 'next.config.mjs'), join(target, 'next.config.mjs'));
