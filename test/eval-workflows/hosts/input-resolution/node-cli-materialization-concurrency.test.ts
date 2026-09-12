import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parseCliEvaluationRequest } from '../../../../src/eval-workflows/input-compilation/index.js';
import { resolveNodeCliEvaluationRequest } from '../../../../src/eval-workflows/hosts/input-resolution/node-cli-evaluation-resolver.js';
import { createWorkflowSampleSetDocument } from '../../../../src/eval-workflows/inputs/schemas/sample-set.js';

const barrier = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, data] = args;
      if (barrier.entered && typeof path === 'string' && path.includes('/content/')
          && (typeof data === 'string' || data instanceof Uint8Array)) {
        const entered = barrier.entered;
        barrier.entered = undefined;
        const file = await actual.open(path, 'wx', 0o600);
        try {
          entered();
          await barrier.release;
          await file.writeFile(data);
        } finally {
          await file.close();
        }
        return;
      }
      await actual.writeFile(...args);
    },
  };
});

it('does not expose a partial resource to another resolver and removes staging files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omk-materialization-race-'));
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { barrier.entered = resolve; });
  barrier.release = new Promise<void>((resolve) => { release = resolve; });
  let first: ReturnType<typeof resolveNodeCliEvaluationRequest> | undefined;
  try {
    await mkdir(join(root, 'skills'));
    await writeFile(join(root, 'skills', 'control.md'), '# Control\nAnswer directly.\n');
    await writeFile(join(root, 'skills', 'treatment.md'), '# Treatment\nUse supplied knowledge.\n');
    await writeFile(join(root, 'samples.json'), JSON.stringify(createWorkflowSampleSetDocument([{
      sample_id: 'sample-a', input: { inputKind: 'text' as const, text: 'Return an answer.' },
      assertions: [{ type: 'contains', value: 'answer' }],
    }])));
    const request = parseCliEvaluationRequest({
      explicitCliFlags: {
        control: 'skills/control.md', treatment: 'skills/treatment.md',
        samples: 'samples.json', 'skill-dir': 'skills',
        executor: 'claude', model: 'claude-test', 'no-judge': true,
      },
      defaults: {
        samplesLocator: 'samples.json', skillDirectoryLocator: 'skills',
        targetRuntime: { executorId: 'claude', model: 'claude-test', effort: 'low' },
        judgeMembers: [],
        presentation: {
          projectOutputDirectoryLocator: join(root, 'reports'),
          globalOutputDirectoryLocator: join(root, 'global-reports'),
          language: 'zh', languageDefaultSource: 'environment-selection',
        },
      },
    });
    const options = { projectRoot: root, materializationRoot: join(root, 'resolved') };
    first = resolveNodeCliEvaluationRequest(request, options);
    await Promise.race([entered, first.then(() => { throw new Error('Write barrier was not reached'); })]);
    const second = await resolveNodeCliEvaluationRequest(request, options);
    release();
    const completed = await first;
    expect(completed).toEqual(second);
    const contentRoot = join(options.materializationRoot, 'content');
    const files = await readdir(contentRoot);
    expect(files.some((file) => file.startsWith('.materialize-'))).toBe(false);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect((await readFile(join(contentRoot, file))).length).toBeGreaterThan(0);
  } finally {
    release();
    await first?.catch(() => undefined);
    barrier.entered = undefined;
    barrier.release = undefined;
    await rm(root, { recursive: true, force: true });
  }
});
