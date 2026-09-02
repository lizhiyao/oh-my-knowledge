import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { globalLayout, projectLayout, type OmkLayout } from './index.js';

export type CleanCategory = 'state' | 'reports' | 'observations' | 'backups' | 'governance';

export interface CleanTarget {
  readonly category: CleanCategory;
  readonly path: string;
  readonly bytes: number;
}

export interface CleanPlan {
  readonly scope: 'project' | 'global';
  readonly root: string;
  readonly targets: readonly CleanTarget[];
  readonly totalBytes: number;
  readonly requiresForce: boolean;
}

function pathBytes(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => {
    try { return sum + pathBytes(resolve(path, entry)); } catch { return sum; }
  }, 0);
}

function categoryPaths(layout: OmkLayout, category: CleanCategory): string[] {
  switch (category) {
    case 'state': return [layout.stateDir];
    case 'reports': return [layout.evalDir, layout.doctorDir, layout.observeHealthDir];
    case 'observations': return [
      layout.observeInboxDir,
      layout.observeDraftsDir,
      layout.observeArchiveDir,
    ];
    case 'backups': return [layout.backupsDir];
    case 'governance': return [layout.governanceDir];
  }
}

function isContained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}

export function planClean(input: Readonly<{
  scope?: 'project' | 'global';
  cwd?: string;
  globalRoot?: string;
  categories?: readonly CleanCategory[];
}> = {}): CleanPlan {
  const scope = input.scope ?? 'project';
  const layout = scope === 'global'
    ? globalLayout(input.globalRoot)
    : projectLayout(input.cwd);
  const categories: CleanCategory[] = [...new Set<CleanCategory>(
    input.categories?.length ? input.categories : ['state'],
  )];
  const targets = categories.flatMap((category) => categoryPaths(layout, category)
    .filter(existsSync)
    .map((path) => ({ category, path, bytes: pathBytes(path) })));
  return Object.freeze({
    scope,
    root: layout.root,
    targets: Object.freeze(targets),
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    requiresForce: categories.includes('observations') || categories.includes('governance'),
  });
}

export function applyClean(plan: CleanPlan): number {
  const layout = plan.scope === 'global' ? globalLayout(plan.root) : projectLayout(dirname(plan.root));
  const allowed = new Set<CleanCategory>(['state', 'reports', 'observations', 'backups', 'governance']);
  const allowedPaths = new Set([...allowed].flatMap((category) => (
    categoryPaths(layout, category).map((path) => resolve(path))
  )));
  for (const target of plan.targets) {
    if (!allowed.has(target.category)
        || !isContained(plan.root, target.path)
        || !allowedPaths.has(resolve(target.path))) {
      throw new TypeError(`Refusing unsafe OMK clean target: ${target.path}`);
    }
  }
  let removed = 0;
  for (const target of plan.targets) {
    if (!existsSync(target.path)) continue;
    rmSync(target.path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
