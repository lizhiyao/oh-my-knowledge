import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  captureExplicitObservation,
} from '../../../src/observability/inbox/explicit-capture.js';
import {
  defaultObservationsDir,
  hasObservationInboxData,
  observationReportsDir,
  projectObservationsDir,
  resolveObservationsDir,
} from '../../../src/observability/inbox/paths.js';
import { loadObservationInboxReports } from '../../../src/observability/inbox/report-store.js';
import { loadObservationReviewState } from '../../../src/observability/inbox/review-state.js';
import { reportFileName } from '../../../src/evidence/storage/file-names.js';
import { FileObservationCaptureStore } from '../../../src/mcp/capture-store.js';
import { OBSERVATION_CAPTURE_SCOPE } from '../../../src/mcp/principal.js';

const CAPTURE = {
  captureSourceKind: 'mcp',
  skillName: 'demo-skill',
  userFeedback: '需要补充失败恢复步骤。',
  confirmedByUser: true,
} as const;

const inboxOf = (root: string): string => join(root, '.omk', 'observe', 'inbox');

/** 项目 inbox 的身份来自调用时 cwd；整段作用域都留在 temp 项目里，await 期间也不例外。 */
async function inProject<T>(projectRoot: string, run: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  mkdirSync(projectRoot, { recursive: true });
  process.chdir(projectRoot);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

function seedReport(inbox: string): void {
  const reports = observationReportsDir(inbox);
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, reportFileName('20260507T000000-a111')), '{}');
}

function captureFiles(inbox: string): string[] {
  const dir = join(inbox, 'captures');
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.capture.json')) : [];
}

describe('observe inbox 路径解析', () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('项目 inbox 按调用时 cwd 求值，不在模块加载时冻结', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const first = join(root, 'first');
    const second = join(root, 'second');

    // 空全局兜底根：让 defaultObservationsDir 稳定回落到项目目录，只考察 cwd 跟随。
    const emptyGlobal = join(root, 'global-empty');
    await inProject(first, () => {
      assert.equal(projectObservationsDir(), inboxOf(first));
      assert.equal(defaultObservationsDir(emptyGlobal), inboxOf(first));
    });
    await inProject(second, () => {
      assert.equal(projectObservationsDir(), inboxOf(second), '已加载的模块要跟着新 cwd 走');
      assert.equal(defaultObservationsDir(emptyGlobal), inboxOf(second));
    });
  });

  it('未指定目录时项目优先，项目无数据才兜底全局，都空回项目', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const project = join(root, 'project');
    const global = join(root, 'global');
    mkdirSync(global, { recursive: true });

    await inProject(project, () => {
      assert.equal(defaultObservationsDir(global), inboxOf(project), '两边都没数据 → 项目');

      seedReport(global);
      assert.equal(defaultObservationsDir(global), global, '项目空、全局有数据 → 全局');

      seedReport(inboxOf(project));
      assert.equal(defaultObservationsDir(global), inboxOf(project), '项目有数据 → 项目优先');
    });
  });

  it('显式目录照读，不参与项目↔全局兜底', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const project = join(root, 'project');
    const explicit = join(root, 'elsewhere');
    mkdirSync(explicit, { recursive: true });

    await inProject(project, () => {
      assert.equal(resolveObservationsDir(explicit), explicit, '空显式目录也不被兜底改写');
      assert.equal(resolveObservationsDir(), defaultObservationsDir(), '不给目录才走兜底');
    });
  });

  it('「有观测数据」看记录不看目录是否存在', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const emptyInbox = join(root, 'inbox-empty');
    mkdirSync(emptyInbox, { recursive: true });
    assert.equal(hasObservationInboxData(emptyInbox), false, '顺手建出来的空目录不算观测过');
    assert.equal(hasObservationInboxData(join(root, 'never-created')), false);

    seedReport(emptyInbox);
    assert.equal(hasObservationInboxData(emptyInbox), true, '报告算');

    const captureInbox = join(root, 'inbox-capture');
    assert.equal(captureExplicitObservation(CAPTURE, { observationsDir: captureInbox }).created, true);
    assert.equal(hasObservationInboxData(captureInbox), true, '显式捕获算');

    const reviewInbox = join(root, 'inbox-review');
    mkdirSync(reviewInbox, { recursive: true });
    writeFileSync(join(reviewInbox, 'review-state.json'), '{}');
    assert.equal(hasObservationInboxData(reviewInbox), true, '复核状态算');
  });

  it('读路径不创建目录，写路径才创建', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const missing = join(root, 'inbox-missing');

    assert.deepEqual(loadObservationInboxReports(missing), []);
    assert.equal(loadObservationReviewState(missing).kind, 'observe-review-state');
    assert.equal(existsSync(missing), false, '读收件箱不该在用户项目里落目录');

    captureExplicitObservation(CAPTURE, { observationsDir: missing });
    assert.equal(captureFiles(missing).length, 1, 'capture 写入自己建父目录');
  });

  it('MCP capture store 未指定目录时按调用时项目解析，不在构造时冻结', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-inbox-paths-')));
    const first = join(root, 'mcp-first');
    const second = join(root, 'mcp-second');
    // 长驻 omk-mcp 进程在 A 目录启动、在 B 目录被调用，捕获要落在实际工作项目里。
    const store = new FileObservationCaptureStore({ partition: 'shared' });
    const principal = {
      tenantId: 'tenant-a',
      principalId: 'principal-a',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };

    await inProject(first, () => store.create(principal, { ...CAPTURE, captureId: 'late-binding-a' }));
    await inProject(second, () => store.create(principal, { ...CAPTURE, captureId: 'late-binding-b' }));

    assert.equal(captureFiles(inboxOf(first)).length, 1, '第一次的 capture 落在当时项目');
    assert.equal(captureFiles(inboxOf(second)).length, 1, '第二次的 capture 落在调用时项目，而不是构造时的 cwd');
  });
});
