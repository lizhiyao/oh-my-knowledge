import { Command } from '@oclif/core';
import { CliExit } from '../lib/cli-exit.js';
import { resolveLang, type Lang } from './i18n.js';

// Shared oclif boundary: command bodies may throw CliExit, and process.argv is
// stable for one CLI invocation, so language resolution is cached per command.
export abstract class BaseCommand extends Command {
  #lang?: Lang;

  protected get lang(): Lang {
    this.#lang ??= resolveLang(process.argv);
    return this.#lang;
  }

  protected async runWithCliExit(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
        return;
      }
      throw err;
    }
  }
}
