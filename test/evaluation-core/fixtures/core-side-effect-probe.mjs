const watchedSignals = [
  'beforeExit',
  'exit',
  'SIGINT',
  'SIGTERM',
  'uncaughtException',
  'unhandledRejection',
];
const listenersBefore = new Map(watchedSignals.map((signal) => (
  [signal, process.rawListeners(signal)]
)));
const originalCwd = process.cwd;
const originalEnv = process.env;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function restoreHostCapabilities() {
  process.cwd = originalCwd;
  process.env = originalEnv;
}

try {
  const [core, advanced, projections, studio] = await Promise.all([
    import('oh-my-knowledge'),
    import('oh-my-knowledge/evaluation-core'),
    import('oh-my-knowledge/projections'),
    import('oh-my-knowledge/studio'),
  ]);

  // Node 的 ESM loader 自身会读取环境变量；外层测试以隔离 HOME 和目录快照检查
  // 导入期副作用。加载完成后再封锁宿主能力，验证公开纯内存操作的运行期边界。
  process.cwd = () => {
    throw new Error('Evaluation Core accessed process.cwd()');
  };
  process.env = new Proxy(Object.create(null), {
    get(_target, property) {
      throw new Error(`Evaluation Core read process.env.${String(property)}`);
    },
    has(_target, property) {
      throw new Error(`Evaluation Core inspected process.env.${String(property)}`);
    },
    ownKeys() {
      throw new Error('Evaluation Core enumerated process.env');
    },
  });

  const canonical = core.canonicalizeJson({ z: 1, a: ['memory-only'] });
  const digest = core.digestCanonicalJson({ z: 1, a: ['memory-only'] });
  if (canonical !== '{"a":["memory-only"],"z":1}'
      || !digest.startsWith('sha256:')
      || typeof core.createEvaluationEngine !== 'function'
      || typeof advanced.assessComparability !== 'function'
      || typeof projections.projectCoreArtifactGraph !== 'function'
      || typeof studio.createCoreStudioCatalog !== 'function') {
    throw new Error('Evaluation Core pure-memory contract operation failed');
  }

  for (const signal of watchedSignals) {
    const before = listenersBefore.get(signal) ?? [];
    const after = process.rawListeners(signal);
    if (after.length !== before.length
        || after.some((listener, index) => listener !== before[index])) {
      throw new Error(`Evaluation Core registered a process hook: ${signal}`);
    }
  }

  restoreHostCapabilities();
} catch (error) {
  restoreHostCapabilities();
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  originalStderrWrite(`${detail}\n`);
  process.exitCode = 1;
}
