import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createStudioDirectorySources,
  type StudioDirectoryRoots,
} from '../../../src/studio/application/directory-sources.js';

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omk-${prefix}-`));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 项目优先解析器被调用的次数：用于证明组成层不在装配期冻结目录。 */
function countedResolver(value: string): { resolve: () => string; calls: () => number } {
  let calls = 0;
  return {
    resolve: () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

function makeRoots(project: string, global: string) {
  const observeHealth = countedResolver(join(project, 'observe-health'));
  const doctors = countedResolver(join(project, 'doctors'));
  const input: StudioDirectoryRoots = {
    reports: { global: () => global, project: () => project },
    observeHealth: { global: () => join(global, 'observe-health'), projectDefault: observeHealth.resolve },
    doctors: { global: () => join(global, 'doctors'), projectDefault: doctors.resolve },
    observations: { global: join(global, 'observe-inbox') },
    managed: () => join(project, 'managed'),
  };
  return { input, observeHealth, doctors };
}

describe('Studio 产物来源的单一目录口径', () => {
  it('缺省模式按请求解析项目优先目录，且不冻结解析结果', () => {
    const project = tempRoot('project');
    const global = tempRoot('global');
    const { input, observeHealth, doctors } = makeRoots(project, global);
    const sources = createStudioDirectorySources(input, {});

    expect(sources.analysesDir).toBeTypeOf('function');
    expect(sources.doctorsDir).toBeTypeOf('function');
    expect(observeHealth.calls()).toBe(0);
    expect((sources.analysesDir as () => string)()).toBe(join(project, 'observe-health'));
    expect((sources.doctorsDir as () => string)()).toBe(join(project, 'doctors'));
    expect(observeHealth.calls()).toBe(1);
    expect(doctors.calls()).toBe(1);
    // 缺省收件箱目录交给 server 默认（项目优先→全局兜底），组成层不替宿主猜。
    expect('observationsDir' in sources).toBe(false);
    expect('agentsDir' in sources).toBe(false);
    expect(sources.includeObserveCards).toBe(true);
    expect(sources.includeDoctorCards).toBe(true);
  });

  it('--global 钉机器级全局目录并关闭跨项目发现', () => {
    const project = tempRoot('project');
    const global = tempRoot('global');
    const { input, observeHealth } = makeRoots(project, global);
    const sources = createStudioDirectorySources(input, { global: true });

    expect((sources.analysesDir as () => string)()).toBe(join(global, 'observe-health'));
    expect((sources.doctorsDir as () => string)()).toBe(join(global, 'doctors'));
    expect(sources.observationsDir).toBe(join(global, 'observe-inbox'));
    expect(observeHealth.calls()).toBe(0);
    expect(sources.includeObserveCards).toBe(false);
    expect(sources.includeDoctorCards).toBe(false);
  });

  it('显式目录固定该目录，相对路径按当前工作目录解析', () => {
    const project = tempRoot('project');
    const global = tempRoot('global');
    const { input } = makeRoots(project, global);
    const sources = createStudioDirectorySources(input, {
      analysesDir: 'relative/analyses',
      doctorsDir: join(project, 'explicit-doctors'),
      observationsDir: 'relative/inbox',
      agentsDir: 'relative/agents',
    });

    expect(sources.analysesDir).toBe(resolve('relative/analyses'));
    expect(sources.doctorsDir).toBe(join(project, 'explicit-doctors'));
    expect(sources.observationsDir).toBe(resolve('relative/inbox'));
    expect(sources.agentsDir).toBe(resolve('relative/agents'));
    expect(sources.includeObserveCards).toBe(false);
    expect(sources.includeDoctorCards).toBe(false);
  });

  it('两个宿主对同一组固定目录得到同一份解析结果', () => {
    const layout = tempRoot('dsh-layout');
    const dsh = makeRoots(layout, layout);
    // DSH：固定 per-project 布局，三档候选同址。
    const dshSources = createStudioDirectorySources(dsh.input, {
      reportsDir: join(layout, 'eval'),
      analysesDir: join(layout, 'observe-health'),
      doctorsDir: join(layout, 'doctors'),
      observationsDir: join(layout, 'observe-inbox'),
    });
    // CLI：同一批目录通过显式 flag 给出，全局候选指向别处也不应被选中。
    const elsewhere = tempRoot('elsewhere');
    const cli = makeRoots(layout, elsewhere);
    const cliSources = createStudioDirectorySources(cli.input, {
      reportsDir: join(layout, 'eval'),
      analysesDir: join(layout, 'observe-health'),
      doctorsDir: join(layout, 'doctors'),
      observationsDir: join(layout, 'observe-inbox'),
    });

    expect({
      analysesDir: cliSources.analysesDir,
      doctorsDir: cliSources.doctorsDir,
      observationsDir: cliSources.observationsDir,
      agentsDir: cliSources.agentsDir,
      includeObserveCards: cliSources.includeObserveCards,
      includeDoctorCards: cliSources.includeDoctorCards,
    }).toEqual({
      analysesDir: dshSources.analysesDir,
      doctorsDir: dshSources.doctorsDir,
      observationsDir: dshSources.observationsDir,
      agentsDir: dshSources.agentsDir,
      includeObserveCards: dshSources.includeObserveCards,
      includeDoctorCards: dshSources.includeDoctorCards,
    });
    expect(cliSources.includeObserveCards).toBe(false);
  });
});
