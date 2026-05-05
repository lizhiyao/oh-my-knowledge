import { execute as debias } from './eval-debias.js';
import { execute as gold } from './eval-gold.js';
import { execute as run } from './eval-runner.js';

export async function execute(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'gold') {
    await gold(rest);
    return;
  }
  if (sub === 'debias') {
    await debias(rest);
    return;
  }

  await run(argv);
}
