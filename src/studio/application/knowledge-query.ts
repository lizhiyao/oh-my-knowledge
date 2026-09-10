import { projectDoctorsDir, projectObserveHealthDir, resolveDoctorsDir, resolveObserveHealthDir } from '../../evidence/storage/directories.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox/index.js';
import { buildSkillIndex, createSkillIndexCache, type SkillIndexCache } from './skill-index.js';

export interface KnowledgeQueryOptions {
  analysesDir?: string | (() => string);
  doctorsDir?: string | (() => string);
  observationsDir?: string;
  includeObserveCards?: boolean;
  includeDoctorCards?: boolean;
}

/**
 * One query and cache lifetime per server; directory fallbacks are resolved per request.
 * 缓存按目录组合分键、有界 LRU；query 随 server 持有，server 停止后整体被回收，
 * 不持有文件句柄或定时器等外部资源。close() 供长会话宿主显式提前释放。
 */
export function createKnowledgeQuery(options: KnowledgeQueryOptions = {}) {
  const cache: SkillIndexCache = createSkillIndexCache();
  const resolve = (value: string | (() => string) | undefined, fallback: () => string): string =>
    typeof value === 'function' ? value() : value ?? fallback();
  const directories = () => ({
    analysesDir: resolve(options.analysesDir, () => resolveObserveHealthDir(projectObserveHealthDir())),
    doctorsDir: resolve(options.doctorsDir, () => resolveDoctorsDir(projectDoctorsDir())),
  });
  return {
    directories,
    read(source = directories()) {
      const { analysesDir, doctorsDir } = source;
      return buildSkillIndex(analysesDir, doctorsDir, options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR, {
        includeObserveCards: options.includeObserveCards ?? false,
        includeDoctorCards: options.includeDoctorCards ?? false,
        cache,
      });
    },
    close() {
      cache.clear();
    },
  };
}
export type KnowledgeQuery = ReturnType<typeof createKnowledgeQuery>;
