import { resolve } from 'node:path';
import { tCli, type CliLang } from '../i18n.js';
import { DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import type { StudioArgs, StudioFlags } from '../types/cmd-flags.js';
import type { ReportServer } from './_shared.js';

async function openWorkbench(url: string, lang: CliLang): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { platform } = await import('node:os');
  const browser = process.env.BROWSER?.trim();
  if (browser?.toLowerCase() === 'none') return;

  const os = platform();
  const command = browser || (os === 'win32' ? 'cmd' : os === 'darwin' ? 'open' : 'xdg-open');
  const args = os === 'win32' && !browser
    ? ['/c', 'start', '', url]
    : [url];
  execFile(command, args, (err) => {
    if (!err) return;
    process.stderr.write(tCli('cli.studio.open_failed', lang, {
      command,
      message: err.message,
    }));
  });
}

export async function runStudio(
  _args: StudioArgs,
  flags: StudioFlags,
  lang: CliLang,
): Promise<void> {
  const reportsDir = flags['reports-dir'] ?? DEFAULT_REPORTS_DIR;

  if (flags.dev && !process.env.__OMK_DEV_CHILD) {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cliPath = resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
    const watchRoot = resolve(cliPath, '..', '..');
    const childArgs = [
      '--watch-path', watchRoot,
      cliPath,
      'studio',
      '--port', flags.port,
      ...(flags.host ? ['--host', flags.host] : []),
      '--reports-dir', reportsDir,
    ];
    if (flags['analyses-dir']) {
      childArgs.push('--analyses-dir', flags['analyses-dir']);
    }
    if (flags['observations-dir']) {
      childArgs.push('--observations-dir', flags['observations-dir']);
    }
    if (flags['no-open']) {
      childArgs.push('--no-open');
    }
    const child = spawn(process.execPath, childArgs, {
      stdio: 'inherit',
      env: { ...process.env, __OMK_DEV_CHILD: '1' },
    });
    child.on('exit', (code: number | null) => process.exit(code || 0));
    return;
  }

  const { createReportServer } = await import('../../server/report-server.js');
  const server: ReportServer = createReportServer({
    port: Number(flags.port),
    ...(flags.host ? { host: flags.host } : {}),
    reportsDir: resolve(reportsDir),
    ...(flags['analyses-dir'] ? { analysesDir: resolve(flags['analyses-dir']) } : {}),
    ...(flags['observations-dir'] ? { observationsDir: resolve(flags['observations-dir']) } : {}),
  });

  const url = await server.start();
  console.log(tCli('cli.studio.started', lang, { url }));
  console.log(tCli('cli.studio.stop_hint', lang));
  if (!flags['no-open'] && process.stdout.isTTY) {
    await openWorkbench(url, lang);
  }
}
