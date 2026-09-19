import { resolve } from 'node:path';
import {
  createNodeCoreContentStore,
  createNodeCoreRunArtifactStore,
  createOverlayCoreRunArtifactStore,
} from '../../eval-workflows/artifact-store/index.js';
import { createCoreStudioCatalog } from './measure/core-run-catalog.js';

/** 目录既可以是定值，也可以是按请求解析的回调：Studio 是长会话，受管根要跟随项目首次 install。 */
export type StudioDirectoryValue = string | (() => string);

/** 宿主解析后的可选目录 flag；未给出的键走默认策略。 */
export interface StudioDirectoryFlags {
  readonly global?: boolean;
  readonly reportsDir?: string;
  readonly analysesDir?: string;
  readonly doctorsDir?: string;
  readonly observationsDir?: string;
  readonly agentsDir?: string;
}

/** 宿主提供给三种模式的候选根目录。固定布局的宿主把三档都指向同一目录即可。 */
export interface StudioDirectoryRoots {
  readonly reports: {
    readonly global: () => string;
    readonly project: () => string;
  };
  readonly observeHealth: {
    readonly global: StudioDirectoryValue;
    /** 缺省模式的取值：可以是定值，也可以是按请求解析的回调，组成层不调用它。 */
    readonly projectDefault: StudioDirectoryValue;
  };
  readonly doctors: {
    readonly global: StudioDirectoryValue;
    readonly projectDefault: StudioDirectoryValue;
  };
  readonly observations: {
    readonly global: string;
  };
  readonly managed: () => string;
}

/**
 * Studio 产物来源的单一解析入口。
 *
 * 目录口径只在这里定义一次：显式 flag 固定该目录，`--global` 钉机器级全局，
 * 缺省走「项目优先→全局兜底」。跨项目发现开关（observe／doctor 卡片）由
 * 「既没钉全局也没给显式目录」推出，宿主不再各自表述。
 */
export function createStudioDirectorySources(
  roots: StudioDirectoryRoots,
  flags: StudioDirectoryFlags = {},
): {
  coreStudioCatalog: ReturnType<typeof createCoreStudioCatalog>;
  analysesDir: StudioDirectoryValue;
  doctorsDir: StudioDirectoryValue;
  observationsDir?: string;
  agentsDir?: string;
  includeObserveCards: boolean;
  includeDoctorCards: boolean;
  managedDir: () => string;
} {
  const coreStoreFor = (directory: string) => createNodeCoreRunArtifactStore(directory, {
    contentResolver: createNodeCoreContentStore(resolve(directory, 'content')),
  });
  const coreReportsDir = flags.reportsDir
    ? resolve(flags.reportsDir)
    : flags.global
      ? roots.reports.global()
      : undefined;
  const coreStudioCatalog = createCoreStudioCatalog(
    coreReportsDir === undefined
      ? createOverlayCoreRunArtifactStore(
        coreStoreFor(roots.reports.project()),
        [coreStoreFor(roots.reports.global())],
      )
      : coreStoreFor(coreReportsDir),
  );
  return {
    coreStudioCatalog,
    analysesDir: flags.analysesDir
      ? resolve(flags.analysesDir)
      : flags.global
        ? roots.observeHealth.global
        : roots.observeHealth.projectDefault,
    doctorsDir: flags.doctorsDir
      ? resolve(flags.doctorsDir)
      : flags.global
        ? roots.doctors.global
        : roots.doctors.projectDefault,
    ...(flags.observationsDir
      ? { observationsDir: resolve(flags.observationsDir) }
      : flags.global
        ? { observationsDir: roots.observations.global }
        : {}),
    ...(flags.agentsDir ? { agentsDir: resolve(flags.agentsDir) } : {}),
    includeObserveCards: !flags.global && !flags.analysesDir,
    includeDoctorCards: !flags.global && !flags.doctorsDir,
    managedDir: () => roots.managed(),
  };
}
