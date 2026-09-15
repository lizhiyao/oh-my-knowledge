import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { globalLayout } from './layout.js';
import { withFileLock } from '../../shared/file-lock.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';

const text = z.string().trim().min(1).max(4096);
export const UserSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  language: z.enum(['zh', 'en']).optional(),
  knowledge: z.strictObject({
    workspace: text.refine(isAbsolute, 'Use an absolute directory.').optional(),
    executor: z.enum(['codex', 'openai-api', 'anthropic-api']).optional(),
    model: text.optional(),
  }).optional(),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;
export interface UserSettingsOverrides { workspace?: string; executor?: string; model?: string; language?: string }
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Versioned local preferences, not evaluation configuration or credential storage. */
export class UserSettingsStore {
  readonly path: string;
  constructor(readonly root = process.env.OMK_HOME || globalLayout().root) { this.path = join(root, 'settings.json'); }
  read(): { settings: UserSettings; revision: string } {
    if (!existsSync(this.path)) return { settings: { schemaVersion: 1 }, revision: 'missing' };
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid settings file.');
    const raw = readFileSync(this.path, 'utf8');
    return { settings: UserSettingsSchema.parse(JSON.parse(raw)), revision: digest(raw) };
  }
  save(input: unknown, expectedRevision: string) {
    const settings = UserSettingsSchema.parse(input);
    return withFileLock(join(this.root, '.settings.lock'), () => {
      if (this.read().revision !== expectedRevision) throw new Error('Settings conflict. Reload before saving.');
      writeJsonFileAtomic(this.path, settings);
      return this.read();
    }, { recoverStale: false });
  }
  resolve(overrides: UserSettingsOverrides = {}, env: NodeJS.ProcessEnv = process.env) {
    const { settings } = this.read();
    const nonempty = (value?: string) => value?.trim() || undefined;
    const language = [overrides.language, env.OMK_LANG, settings.language].find(value => value === 'zh' || value === 'en') as 'zh' | 'en' | undefined;
    const executor = nonempty(overrides.executor) ?? nonempty(env.OMK_EXECUTOR) ?? settings.knowledge?.executor ?? 'codex';
    // Switching provider must not inherit a model configured for another provider.
    const storedModel = (settings.knowledge?.executor ?? 'codex') === executor ? settings.knowledge?.model : undefined;
    return { workspace: nonempty(overrides.workspace) ?? settings.knowledge?.workspace ?? globalLayout(this.root).knowledgeDir,
      executor, model: nonempty(overrides.model) ?? nonempty(env.OMK_MODEL) ?? storedModel ?? '', language: language ?? 'zh' };
  }
}
