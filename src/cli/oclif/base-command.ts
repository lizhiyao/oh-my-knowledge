import { Command } from '@oclif/core';
import { CliExit } from '../lib/cli-exit.js';
import { resolveLangDecision } from './i18n.js';
import type { Lang } from '../../shared/language.js';
import type { LanguageDecision } from '../../shared/language-preference.js';

// Shared oclif boundary: command bodies may throw CliExit, and process.argv is
// stable for one CLI invocation, so language resolution is cached per command.
export abstract class BaseCommand extends Command {
  #decision?: LanguageDecision;

  private get langDecision(): LanguageDecision {
    this.#decision ??= resolveLangDecision(process.argv);
    return this.#decision;
  }

  protected get lang(): Lang {
    return this.langDecision.lang;
  }

  /** 语言是否来自 --lang／OMK_LANG／已保存设置;false 表示来自 locale 推断或兜底。 */
  protected get langConfigured(): boolean {
    return this.langDecision.configured;
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

  protected async runWithCancellation(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      await this.runWithCliExit(() => fn(cancellation.signal));
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
}
