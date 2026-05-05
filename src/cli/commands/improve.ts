import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { execute as failures } from './improve-failures.js';
import { execute as plan } from './improve-plan.js';
import { execute as samples } from './improve-samples.js';
import { execute as skill } from './improve-skill.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const [sub, ...rest] = argv;

  if (!sub) {
    console.log(tCli('cli.help.improve', lang).trim());
    throw new CliExit(1);
  }

  if (sub === 'samples') {
    await samples(rest);
    return;
  }

  if (sub === 'skill') {
    await skill(rest);
    return;
  }

  if (sub === 'plan') {
    await plan(rest);
    return;
  }

  if (sub === 'failures') {
    await failures(rest);
    return;
  }

  // Bare `omk improve <report-id>` is the common path: produce a repair plan
  // from the finished report without forcing users to remember `plan`.
  await plan([sub, ...rest]);
}
