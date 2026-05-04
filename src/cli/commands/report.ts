import { CliExit } from '../cli-exit.js';
import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportDocument, ReportStore } from '../../types/index.js';
import type { ReportServer } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      port: { type: 'string', default: '7799' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      export: { type: 'string' },
      dev: { type: 'boolean', default: false },
    },
  });

  // Dev mode: restart server on file changes via node --watch
  if (values.dev && !process.env.__OMK_DEV_CHILD) {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // import.meta.url 指 commands/report.js,但 child 必须 spawn CLI 入口 index.js
    // (那里有 main() 跑 dispatcher);否则 child 跑的是 report module,只 export
    // execute,无入口直接退出,--dev 静默坏掉。
    const cliPath: string = resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
    // watch 整个编译产物根 (dist/src/),覆盖 server / renderer / eval-core 等
    // report server 依赖的 module。原来是 resolve(cliPath, '..', 'lib') = dist/src/cli/lib,
    // 那个目录不存在,node --watch-path 对不存在路径静默,hot reload 一直没在工作。
    const libDir: string = resolve(cliPath, '..', '..');
    const args: string[] = [
      '--watch-path', libDir, cliPath, 'bench', 'report',
      '--port', values.port as string,
      '--reports-dir', values['reports-dir'] as string,
    ];
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, __OMK_DEV_CHILD: '1' },
    });
    // 子进程 exit 透传:这一行在 spawn 的 async listener 里,不在 main 调用栈,
    // 不能 throw CliExit (没人 catch),只能 process.exit。
    child.on('exit', (code: number | null) => process.exit(code || 0));
    return;
  }

  if (values.export) {
    const { createFileStore } = await import('../../server/report-store.js');
    const { renderReportDocumentDetail } = await import('../../renderer/html-renderer.js');
    const { writeFileSync } = await import('node:fs');
    const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
    const report: ReportDocument | null = await store.get(values.export as string);
    if (!report) {
      console.error(tCli('cli.common.report_not_found', lang, { id: values.export as string }));
      throw new CliExit(1);
    }
    const html: string = renderReportDocumentDetail(report);
    const outPath: string = resolve(`${values.export}.html`);
    writeFileSync(outPath, html);
    console.log(`Exported to: ${outPath}`);
    console.log('Open in browser, or Ctrl+P to save as PDF');
    return;
  }

  const { createReportServer } = await import('../../server/report-server.js');
  const server: ReportServer = createReportServer({
    port: Number(values.port),
    reportsDir: resolve(values['reports-dir'] as string),
  });

  const url: string = await server.start();
  console.log(`Report server running at ${url}`);
  console.log('Press Ctrl+C to stop');
}
