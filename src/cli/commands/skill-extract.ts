import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { enumStringParser } from '../oclif/parsers.js';
import { type CliLang } from '../lib/i18n.js';
import type { SkillExtractArgs, SkillExtractFlags } from '../lib/cmd-flags.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox.js';
import { updateObservationReviewState } from '../../observability/review-state.js';
import { updateSkillDerivedStandardStatus, type SkillDerivedStandardStatus } from '../../observability/soft-standards.js';

const STATUS_VALUES = ['author_confirmed', 'rejected', 'pending_review', 'confirm', 'confirmed', 'reject', 'pending'] as const;

function canonicalStatus(value?: string): SkillDerivedStandardStatus {
  if (!value || value === 'confirm' || value === 'confirmed') return 'author_confirmed';
  if (value === 'reject') return 'rejected';
  if (value === 'pending') return 'pending_review';
  return value as SkillDerivedStandardStatus;
}

export async function runSkillExtract(
  args: SkillExtractArgs,
  flags: SkillExtractFlags,
  lang: CliLang,
): Promise<void> {
  const skillName = args.skillName;
  const standardId = flags.review;
  const status = canonicalStatus(flags.status);
  const observationsDir = resolve(flags['input-dir'] || DEFAULT_OBSERVATIONS_DIR);
  const now = new Date().toISOString();
  const record = updateSkillDerivedStandardStatus(observationsDir, skillName, standardId, status, now);
  const verdict = status === 'author_confirmed' ? 'real_issue' : status === 'rejected' ? 'not_issue' : 'needs_more_context';
  const reviewState = updateObservationReviewState(observationsDir, {
    targetType: 'soft_standard',
    targetId: `${skillName}:${standardId}`,
    verdict,
    reason: flags.reason,
  }, now);
  if (flags.json) {
    console.log(JSON.stringify({ kind: 'skill-extract-review', skillName, standardId, status, record, reviewState }, null, 2));
    return;
  }
  console.log(lang === 'zh'
    ? `软标准已复核：${skillName} ${standardId} status=${status}`
    : `Soft standard reviewed: ${skillName} ${standardId} status=${status}`);
}

export default class SkillExtract extends BaseCommand {
  static description = bilingual({
    zh: '确认或否决 skill 软标准候选。',
    en: 'Confirm or reject skill soft standard candidates.',
  });

  static args = {
    skillName: Args.string({
      description: bilingual({ zh: 'skill 名称', en: 'Skill name' }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    'input-dir': Flags.string({
      description: bilingual({ zh: 'observation 数据目录', en: 'Observation data directory' }),
    }),
    review: Flags.string({
      description: bilingual({ zh: '要确认或否决的软标准 ID', en: 'Soft standard id to review' }),
      required: true,
    }),
    status: Flags.string({
      description: bilingual({
        zh: '确认状态：author_confirmed / rejected / pending_review（也接受 confirm / confirmed / reject / pending 别名）',
        en: 'Review status: author_confirmed / rejected / pending_review (also accepts aliases: confirm / confirmed / reject / pending)',
      }),
      parse: enumStringParser('--status', STATUS_VALUES),
    }),
    reason: Flags.string({
      description: bilingual({ zh: '人工判断原因', en: 'Manual review reason' }),
    }),
    json: Flags.boolean({
      description: bilingual({ zh: 'JSON 格式输出', en: 'JSON output' }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SkillExtract);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runSkillExtract(args, { ...flags, lang }, lang);
    });
  }
}
