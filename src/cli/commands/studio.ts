import { resolve } from 'node:path';
import { langFromArgv, tCli } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportServer } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      port: { type: 'string', default: '7799' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      'analyses-dir': { type: 'string' },
      dev: { type: 'boolean', default: false },
    },
  });

  if (values.dev && !process.env.__OMK_DEV_CHILD) {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cliPath = resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
    const watchRoot = resolve(cliPath, '..', '..');
    const args = [
      '--watch-path', watchRoot,
      cliPath,
      'studio',
      '--port', values.port as string,
      '--reports-dir', values['reports-dir'] as string,
    ];
    if (values['analyses-dir']) {
      args.push('--analyses-dir', values['analyses-dir'] as string);
    }
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, __OMK_DEV_CHILD: '1' },
    });
    child.on('exit', (code: number | null) => process.exit(code || 0));
    return;
  }

  const { createReportServer } = await import('../../server/report-server.js');
  const server: ReportServer = createReportServer({
    port: Number(values.port),
    reportsDir: resolve(values['reports-dir'] as string),
    ...(values['analyses-dir'] ? { analysesDir: resolve(values['analyses-dir'] as string) } : {}),
  });

  const url = await server.start();
  console.log(tCli('cli.studio.started', lang, { url }));
  console.log(tCli('cli.studio.stop_hint', lang));
}
