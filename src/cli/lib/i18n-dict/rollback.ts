import type { CliMessage } from './types.js';

export type RollbackMessageKey =
  | 'cli.rollback.kind_unsupported'
  | 'cli.rollback.not_managed'
  | 'cli.rollback.not_promoted'
  | 'cli.rollback.rolled_back'
  | 'cli.rollback.already_rolled_back';

export const rollbackDict: Record<RollbackMessageKey, CliMessage> = {
  'cli.rollback.kind_unsupported': {
    zh: 'rollback 暂仅支持 kind=skill；收到 {kind}。',
    en: 'rollback supports only kind=skill today; got {kind}.',
  },
  'cli.rollback.not_managed': {
    zh: '未找到受管记录 {name}（kind={kind}）。omk rollback 只作用于已 install 的 skill。',
    en: 'No managed record {name} (kind={kind}). omk rollback only operates on installed skills.',
  },
  'cli.rollback.not_promoted': {
    zh: '{name} 的当前内容未处于 promoted 态，无可回退（omk list 看生命周期状态）。',
    en: '{name} current content is not promoted; nothing to roll back (omk list shows the lifecycle state).',
  },
  'cli.rollback.rolled_back': {
    zh: '已回退 {name}：撤销当前内容 {hash} 的 promoted 接受（已记为人工决定）。源仍匹配受管基线则 omk list 回到 measurable，源已漂移则仍为 stale。',
    en: 'Rolled back {name}: revoked the promoted acceptance of current content {hash} (recorded as a human decision). omk list shows measurable if the source still matches the managed baseline, or stale if it has drifted.',
  },
  'cli.rollback.already_rolled_back': {
    zh: '{name} 的当前内容本就未 promoted，无需回退（幂等，未改动记录）。',
    en: '{name} current content is already not promoted; nothing to do (idempotent, record untouched).',
  },
};
