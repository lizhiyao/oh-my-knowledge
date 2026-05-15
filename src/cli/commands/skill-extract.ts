import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox.js';
import { updateObservationReviewState } from '../../observability/review-state.js';
import { updateSkillDerivedStandardStatus, type SkillDerivedStandardStatus } from '../../observability/soft-standards.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';

export async function execute(argv: string[]): Promise<void> {
  const { values: rawValues, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      'input-dir': { type: 'string' },
      review: { type: 'string' },
      status: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const values = rawValues as Record<string, string | boolean | undefined>;
  const skillName = positionals[0];
  const standardId = typeof values.review === 'string' ? values.review : '';
  if (!skillName || !standardId) {
    console.error('Usage: omk skill-extract <skill> --review <standard-id> [--status author_confirmed|rejected|pending_review] [--input-dir <path>]');
    throw new CliExit(1);
  }
  const status = normalizeStatus(typeof values.status === 'string' ? values.status : undefined);
  const observationsDir = resolve((values['input-dir'] as string | undefined) || DEFAULT_OBSERVATIONS_DIR);
  const now = new Date().toISOString();
  const record = updateSkillDerivedStandardStatus(observationsDir, skillName, standardId, status, now);
  const verdict = status === 'author_confirmed' ? 'real_issue' : status === 'rejected' ? 'not_issue' : 'needs_more_context';
  const reviewState = updateObservationReviewState(observationsDir, {
    targetType: 'soft_standard',
    targetId: `${skillName}:${standardId}`,
    verdict,
    reason: typeof values.reason === 'string' ? values.reason : undefined,
  }, now);
  if (values.json === true) {
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
  throw new Error(`invalid status: ${value}`);
}
