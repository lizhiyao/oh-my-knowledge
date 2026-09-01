import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { tCli, type CliLang } from './i18n.js';

export async function openWorkbench(url: string, lang: CliLang): Promise<void> {
  const browser = process.env.BROWSER?.trim();
  if (browser?.toLowerCase() === 'none') return;
  const os = platform();
  const command = browser || (os === 'win32' ? 'cmd' : os === 'darwin' ? 'open' : 'xdg-open');
  const args = os === 'win32' && !browser ? ['/c', 'start', '', url] : [url];
  execFile(command, args, (error) => {
    if (error === null) return;
    process.stderr.write(tCli('cli.studio.open_failed', lang, {
      command,
      message: error.message,
    }));
  });
}
