import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../oclif/i18n.js';
import { CliExit } from '../lib/cli-exit.js';
import { type CliLang } from '../lib/i18n.js';
import type { SkillExtractArgs, SkillExtractFlags } from '../lib/cmd-flags.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox.js';
import { updateObservationReviewState } from '../../observability/review-state.js';
import { updateSkillDerivedStandardStatus, type SkillDerivedStandardStatus } from '../../observability/soft-standards.js';

export async function runSkillExtract(
  args: SkillExtractArgs,
  flags: SkillExtractFlags,
  _lang: CliLang,
): Promise<void> {
  const skillName = args.skillName;
  const standardId = flags.review || '';
  if (!skillName || !standardId) {
    console.error('Usage: omk skill-extract <skill> --review <standard-id> [--status author_confirmed|rejected|pending_review] [--input-dir <path>]');
    throw new CliExit(2);
  }
  const status = normalizeStatus(flags.status);
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
  console.log(`soft standard reviewed: ${skillName} ${standardId} status=${status}`);
}

function normalizeStatus(value?: string): SkillDerivedStandardStatus {
  if (!value || value === 'confirm' || value === 'confirmed') return 'author_confirmed';
  if (value === 'author_confirmed' || value === 'rejected' || value === 'pending_review') return value;
  if (value === 'reject') return 'rejected';
  if (value === 'pending') return 'pending_review';
  console.error(`invalid status: ${value}`);
  throw new CliExit(2);
}

export default class SkillExtract extends Command {
  static description = bilingual({
    zh: '确认或否决 skill 软标准候选。',
    en: 'Confirm or reject skill soft standard candidates.',
  });

  static args = {
    skillName: Args.string({
      description: bilingual({ zh: 'skill 名称', en: 'Skill name' }),
      required: false,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'input-dir': Flags.string({
      description: bilingual({ zh: 'observation 数据目录', en: 'Observation data directory' }),
    }),
    review: Flags.string({
      description: bilingual({ zh: '要确认或否决的软标准 ID', en: 'Soft standard id to review' }),
    }),
    status: Flags.string({
      description: bilingual({
        zh: '确认状态：author_confirmed / rejected / pending_review',
        en: 'Review status: author_confirmed / rejected / pending_review',
      }),
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
    const lang = resolveLang(process.argv);
    try {
      await runSkillExtract(args, { ...flags, lang }, lang);
    } catch (err) {
      if (err instanceof CliExit) {
        this.exit(err.code);
        return;
      }
      throw err;
    }
  }
}
