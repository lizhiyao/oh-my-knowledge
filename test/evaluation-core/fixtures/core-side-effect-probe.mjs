import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [repositoryRoot] = process.argv.slice(2);
if (repositoryRoot === undefined) throw new Error('repository root is required');

const moduleUrls = [
  'contracts/index.js',
  'compiler/index.js',
  'execution/index.js',
  'evaluation/index.js',
  'analysis/index.js',
].map((entry) => pathToFileURL(resolve(
  repositoryRoot,
  'dist/evaluation-core',
  entry,
)).href);

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
  const [contracts, compiler, execution] = await Promise.all(
    moduleUrls.map((url) => import(url)),
  );

  // Node 的 ESM loader 自身会读取环境变量；Core 源码的导入期环境访问由静态
  // dependency-closure guard 证明不存在。加载完成后再封锁宿主能力，验证运行期。
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

  const canonical = contracts.canonicalizeJson({ z: 1, a: ['memory-only'] });
  const digest = contracts.digestCanonicalJson({ z: 1, a: ['memory-only'] });
  if (canonical !== '{"a":["memory-only"],"z":1}'
      || !digest.startsWith('sha256:')) {
    throw new Error('Evaluation Core pure-memory contract operation failed');
  }

  const sequencer = new execution.InMemoryRuntimeEventSequencer();
  if (sequencer.next('isolated-run') !== 0
      || sequencer.next('isolated-run') !== 1) {
    throw new Error('Evaluation Core pure-memory runtime operation failed');
  }

  let rejectedInvalidDefinition = false;
  try {
    await compiler.prepareEvaluationPlan({}, {}, {
      schemaValidators: new Map(),
      resolveExecutor() {
        throw new Error('invalid input must fail before Runtime resolution');
      },
      resolveEvaluator() {
        throw new Error('invalid input must fail before Runtime resolution');
      },
      resolveAnalysis() {
        throw new Error('invalid input must fail before Runtime resolution');
      },
    });
  } catch (error) {
    rejectedInvalidDefinition = error instanceof compiler.EvaluationDefinitionError;
  }
  if (!rejectedInvalidDefinition) {
    throw new Error('Evaluation Core compiler did not run its in-memory validation');
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
