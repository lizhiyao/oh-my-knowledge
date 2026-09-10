import { Config, Errors, run } from '@oclif/core';
import { CliExit } from '../lib/cli-exit.js';
import LangAwareHelp from './help.js';

// Keep oclif parsing and dispatch, but own the final output/exit boundary.
// execute() calls an error handler that process.exit()s before stderr drains.
export async function runOclifPath(): Promise<void> {
  const config = await Config.load(import.meta.url);
  try {
    await run(process.argv.slice(2), config);
  } catch (error) {
    if (error instanceof Errors.ExitError) throw new CliExit(error.oclif.exit ?? 1);
    // Flag parse callbacks may throw plain Error objects decorated by oclif.
    if (!(error instanceof Error) || !('oclif' in error) || !error.oclif
      || typeof error.oclif !== 'object' || !('exit' in error.oclif)
      || typeof error.oclif.exit !== 'number') throw error;
    if (!('skipOclifErrorHandling' in error && error.skipOclifErrorHandling)) {
      console.error(`${error.name}: ${error.message}`);
      if ('ref' in error && typeof error.ref === 'string') console.error(error.ref);
      if ('code' in error && typeof error.code === 'string') console.error(`Code: ${error.code}`);
      if ('suggestions' in error && Array.isArray(error.suggestions)) {
        for (const suggestion of error.suggestions) console.error(suggestion);
      }
      if (error.cause) console.error(error.cause);
      if ('showHelp' in error && error.showHelp) {
        const help = new LangAwareHelp(config, { sendToStderr: true, sections: ['flags', 'usage', 'arguments'] });
        await help.showHelp(process.argv.slice(2));
      }
    }
    throw new CliExit(error.oclif.exit ?? 1);
  }
}
