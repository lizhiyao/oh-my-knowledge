import type { CoreRunArtifactStore, StoredCoreRunArtifacts } from '../../eval-workflows/hosts/application.js';
import type { CliLang } from './i18n.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';

export async function announceCoreReport(
  artifacts: StoredCoreRunArtifacts,
  store: CoreRunArtifactStore,
  outputDirectory: string,
  serve: boolean,
  lang: CliLang,
  gateExitCode: 0 | 1,
  signal?: AbortSignal,
): Promise<void> {
  process.stderr.write(lang === 'zh'
    ? `Core 评测产物已保存：${artifacts.manifest.runId}\n`
    : `Core evaluation artifacts saved: ${artifacts.manifest.runId}\n`);
  if (!serve) return;
  if (gateExitCode !== 0) {
    const command = `omk studio --reports-dir ${shellQuoteArg(outputDirectory)}`;
    process.stderr.write(lang === 'zh'
      ? `评测门禁未通过，将以退出码 ${gateExitCode} 结束。查看已保存的报告：${command}\n`
      : `The evaluation gate did not pass; exiting with code ${gateExitCode}. View the saved report: ${command}\n`);
    return;
  }
  if (!process.stdout.isTTY) {
    process.stderr.write(lang === 'zh'
      ? `非交互终端不自动启动 Studio。运行 omk studio --reports-dir ${shellQuoteArg(outputDirectory)} 查看。\n`
      : `Studio was not started in a non-interactive terminal. Run omk studio --reports-dir ${shellQuoteArg(outputDirectory)}.\n`);
    return;
  }
  const { createCoreStudioCatalog } = await import('../../studio/application/core-run-catalog.js');
  const { createReportServer } = await import('../../studio/http/report-server.js');
  const server = createReportServer({
    coreStudioCatalog: createCoreStudioCatalog(store),
    // 评测预览宿主只服务 /measure 报告页，裁剪收件箱路由（#839 批次 0）。
    observationInbox: false,
  });
  const serverUrl = await server.start();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
    void server.stop().catch((error: unknown) => {
      process.stderr.write(`${lang === 'zh' ? '报告服务关闭失败' : 'Report server shutdown failed'}: ${String(error)}\n`);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) { stop(); return; }
  const reportUrl = `${serverUrl}/measure/${encodeURIComponent(artifacts.manifest.runId)}`;
  process.stderr.write(lang === 'zh'
    ? `报告服务：${serverUrl}\n查看本次评测：${reportUrl}\n按 Ctrl+C 停止。\n`
    : `Report server: ${serverUrl}\nView this run: ${reportUrl}\nPress Ctrl+C to stop.\n`);
  const { openWorkbench } = await import('./open-workbench.js');
  await openWorkbench(reportUrl, lang);
}

