import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { integerStringParser } from '../oclif/parsers.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { resolveManagedDir, managedDir } from '../../managed/index.js';
import {
  resolveObserveHealthDir, projectObserveHealthDir, globalObserveHealthDir,
  resolveDoctorsDir, projectDoctorsDir, globalDoctorsDir,
  projectReportsDir, globalReportsDir,
} from '../../eval-core/measurement-dirs.js';
import { DEFAULT_GLOBAL_OBSERVATIONS_DIR } from '../../observability/inbox.js';
import type { ReportServer } from '../lib/shared.js';
import type { StudioArgs, StudioFlags } from '../lib/cmd-flags.js';
import { openWorkbench } from '../lib/open-workbench.js';

// dev / browser-open 测试需要 mock `node:child_process` + `node:os`,通过 in-process
// import 直接调用。把业务作为 module-level helper export 从 Command file 暴露,
// 既保留 test 兼容又让产品命令树语义干净(无 legacy commands directory)。
export async function runStudio(
  _args: StudioArgs,
  flags: StudioFlags,
  lang: CliLang,
): Promise<void> {
  // reports 读取目录:显式 --reports-dir 固定该目录;--global 钉全局;默认 = undefined,交给
  // createReportServer 建 indexed(机器级聚合:当前项目 + 全局 live ∪ 别项目索引卡片)。
  const reportsDirOpt = flags['reports-dir']
    ? resolve(flags['reports-dir'])
    : flags.global
      ? globalReportsDir()
      : undefined;

  if (flags.dev && !process.env.__OMK_DEV_CHILD) {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // 路径绑定:`commands/studio.{ts,js}` → 两层 `..` 回 `cli/`,再 `index.js`。
    // 移动本文件到不同嵌套(例如 `commands/group/studio.ts`)需同步改 `..` 数量。
    // cli/index.{ts,js} 在源跟 dist 中位置一致(src/cli/index.ts → dist/cli/index.js)。
    const cliPath = resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
    const watchRoot = resolve(cliPath, '..', '..');
    const childArgs = [
      '--watch-path', watchRoot,
      cliPath,
      'studio',
      '--port', flags.port,
      ...(flags.host ? ['--host', flags.host] : []),
    ];
    if (flags['reports-dir']) {
      childArgs.push('--reports-dir', flags['reports-dir']);
    }
    if (flags['analyses-dir']) {
      childArgs.push('--analyses-dir', flags['analyses-dir']);
    }
    if (flags['doctors-dir']) {
      childArgs.push('--doctors-dir', flags['doctors-dir']);
    }
    if (flags['observations-dir']) {
      childArgs.push('--observations-dir', flags['observations-dir']);
    }
    if (flags.global) {
      childArgs.push('--global');
    }
    if (flags['no-open']) {
      childArgs.push('--no-open');
    }
    const child = spawn(process.execPath, childArgs, {
      stdio: 'inherit',
      env: { ...process.env, __OMK_DEV_CHILD: '1' },
    });
    // child 被 signal kill 时 code=null,用 ?? 退 1 让父进程感知异常退出,
    // 不要 `code || 0` 把 null 当 0 假装成功(把 signal kill / unknown exit 也
    // 当成功上报会让 omk studio --dev 的 crash 静默)。
    child.on('exit', (code: number | null) => process.exit(code ?? 1));
    return;
  }

  const { createReportServer } = await import('../../server/report-server.js');
  const {
    createNodeCoreContentStore,
    createNodeCoreRunArtifactStore,
    createOverlayCoreRunArtifactStore,
  } = await import('../../eval-workflows/artifact-store/index.js');
  const { createCoreStudioCatalog } = await import('../../eval-workflows/studio-catalog/index.js');
  const coreStoreFor = (directory: string) => createNodeCoreRunArtifactStore(directory, {
    contentResolver: createNodeCoreContentStore(resolve(directory, 'content')),
  });
  const coreStore = reportsDirOpt !== undefined
    ? coreStoreFor(reportsDirOpt)
    : createOverlayCoreRunArtifactStore(
        coreStoreFor(projectReportsDir()),
        [coreStoreFor(globalReportsDir())],
      );
  const server: ReportServer = createReportServer({
    port: Number(flags.port),
    ...(flags.host ? { host: flags.host } : {}),
    // reportsDir 缺省 undefined → server 建 indexed(机器级:当前项目 + 全局 + 别项目索引卡片);
    // 显式 --reports-dir / --global 固定单目录(逃生舱,不走聚合)。
    ...(reportsDirOpt !== undefined ? { reportsDir: reportsDirOpt } : {}),
    coreStudioCatalog: createCoreStudioCatalog(coreStore),
    // 测量产物(observe-health / doctors)默认按请求项目优先→全局兜底(同 managed);
    // 显式 --analyses-dir/--doctors-dir 固定该目录;--global 钉全局目录。
    analysesDir: flags['analyses-dir']
      ? resolve(flags['analyses-dir'])
      : (flags.global ? globalObserveHealthDir : (): string => resolveObserveHealthDir(projectObserveHealthDir())),
    doctorsDir: flags['doctors-dir']
      ? resolve(flags['doctors-dir'])
      : (flags.global ? globalDoctorsDir : (): string => resolveDoctorsDir(projectDoctorsDir())),
    // 只有默认机器级模式才合别项目的索引卡片;--global / 显式 --analyses-dir / --doctors-dir 是逃生舱,
    // 只看固定目录(与 reports 的 --reports-dir 关闭 indexed store 对称)。observe / doctor 各自独立判定。
    includeObserveCards: !flags.global && !flags['analyses-dir'],
    includeDoctorCards: !flags.global && !flags['doctors-dir'],
    // observe-inbox 缺省按请求项目优先→全局兜底(report-server 默认即此);显式 --observations-dir 固定该目录;
    // --global 钉全局(与 observe-health / doctors 的 --global 一致)。
    ...(flags['observations-dir']
      ? { observationsDir: resolve(flags['observations-dir']) }
      : flags.global
        ? { observationsDir: DEFAULT_GLOBAL_OBSERVATIONS_DIR }
        : {}),
    // 传解析器而非解析结果:Studio 是长会话,受管根目录要按请求解析(项目首次 install 后从 global 切回
    // project),与 omk list 同口径;若在此处一次性解析、冻结进 server,长会话里会与 CLI 分叉。
    managedDir: (): string => resolveManagedDir(managedDir()),
  });

  const url = await server.start();
  console.log(tCli('cli.studio.started', lang, { url }));
  console.log(tCli('cli.studio.stop_hint', lang));
  if (!flags['no-open'] && process.stdout.isTTY) {
    await openWorkbench(url, lang);
  }
}

export default class Studio extends BaseCommand {
  static description = bilingual({
    zh: '启动 omk Studio 报告服务（skill-centric 仪表盘 + 浏览器自动打开）。',
    en: 'Start omk Studio report server (skill-centric dashboard + browser auto-open).',
  });

  static examples = [
    {
      description: bilingual({ zh: '默认端口 7799', en: 'Default port 7799' }),
      command: '<%= config.bin %> studio',
    },
    {
      description: bilingual({
        zh: '指定端口，不打开浏览器',
        en: 'Custom port, no browser',
      }),
      command: '<%= config.bin %> studio --port 8080 --no-open',
    },
  ];

  static flags = {
    lang: LANG_FLAG,
    port: Flags.string({
      description: bilingual({
        zh: '监听端口，默认 7799。传 0 让 OS 分配',
        en: 'Listen port, default 7799. Pass 0 for OS-assigned',
      }),
      default: '7799',
      parse: integerStringParser('--port', { min: 0, max: 65_535 }),
    }),
    host: Flags.string({
      description: bilingual({
        zh: '监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网',
        en: 'Listen host, default localhost. Use 0.0.0.0 to expose to LAN',
      }),
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '只看指定报告目录（可选；默认机器级聚合：当前项目 + 全局 + 别项目索引）',
        en: 'View only this reports dir (optional; default aggregates machine-wide: current project + global + other projects via index)',
      }),
    }),
    'analyses-dir': Flags.string({
      description: bilingual({
        zh: '观测健康报告目录（可选，默认项目级 .omk/observe-health，空则全局兜底）',
        en: 'Observe-health reports dir (optional, default project .omk/observe-health, falls back to global)',
      }),
    }),
    'doctors-dir': Flags.string({
      description: bilingual({
        zh: '体检报告目录（可选，默认项目级 .omk/doctors，空则全局兜底）',
        en: 'Doctor reports dir (optional, default project .omk/doctors, falls back to global)',
      }),
    }),
    'observations-dir': Flags.string({
      description: bilingual({
        zh: '观测收件箱数据目录（可选，默认 .omk/observe-inbox）',
        en: 'Observe-inbox data dir (optional, default .omk/observe-inbox)',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '只看全局 reports / observe-health / doctors / observe-inbox 目录（~/.oh-my-knowledge/*），而非机器级聚合 / 项目优先；managed 不受影响',
        en: 'View only global reports / observe-health / doctors / observe-inbox dirs (~/.oh-my-knowledge/*) instead of machine-wide / project-first; does not affect managed',
      }),
    }),
    'no-open': Flags.boolean({
      description: bilingual({
        zh: '不自动打开浏览器',
        en: 'Do not auto-open browser',
      }),
      default: false,
    }),
    dev: Flags.boolean({
      description: bilingual({
        zh: 'dev 模式：子进程启动 + 热更新',
        en: 'Dev mode: child process with hot reload',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Studio);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runStudio({}, { ...flags, lang }, lang);
    });
  }
}
