import type { ExecutableExecutorName } from './registry.js';

export interface OptionalExecutorDependency {
  readonly packageName: string;
  readonly installSpec: string;
}

const OPTIONAL_EXECUTOR_DEPENDENCIES: Partial<Record<ExecutableExecutorName, OptionalExecutorDependency>> = {
  'claude-sdk': {
    packageName: '@anthropic-ai/claude-agent-sdk',
    installSpec: '@anthropic-ai/claude-agent-sdk@^0.3.143',
  },
  'codex-sdk': {
    packageName: '@openai/codex-sdk',
    installSpec: '@openai/codex-sdk@0.149.0',
  },
};

export function getOptionalExecutorDependency(
  executorName: ExecutableExecutorName,
): OptionalExecutorDependency | undefined {
  return OPTIONAL_EXECUTOR_DEPENDENCIES[executorName];
}

function packageAvailable(packageName: string): boolean {
  try {
    // Use ESM resolution because @openai/codex-sdk only exposes an `import`
    // condition; createRequire().resolve() reports ERR_PACKAGE_PATH_NOT_EXPORTED
    // even when that optional peer is correctly installed.
    import.meta.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

export function assertOptionalExecutorDependency(
  executorName: ExecutableExecutorName,
  available: (packageName: string) => boolean = packageAvailable,
): void {
  const dependency = getOptionalExecutorDependency(executorName);
  if (!dependency || available(dependency.packageName)) return;

  throw new Error([
    `执行器「${executorName}」需要可选依赖「${dependency.packageName}」，但当前 OMK 安装作用域中未找到。`,
    `本地安装：npm install ${dependency.installSpec}`,
    `全局安装：npm install -g ${dependency.installSpec}`,
  ].join('\n'));
}
