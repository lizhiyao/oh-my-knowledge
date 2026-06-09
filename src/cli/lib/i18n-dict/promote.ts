import type { CliMessage } from './types.js';

export type PromoteMessageKey =
  | 'cli.promote.kind_unsupported'
  | 'cli.promote.not_managed'
  | 'cli.promote.blocked_header'
  | 'cli.promote.drifted'
  | 'cli.promote.no_current_evidence'
  | 'cli.promote.incomparable'
  | 'cli.promote.incomparable_unverified'
  | 'cli.promote.verdict_blocked'
  | 'cli.promote.force_hint'
  | 'cli.promote.promoted'
  | 'cli.promote.forced_override'
  | 'cli.promote.already_promoted';

export const promoteDict: Record<PromoteMessageKey, CliMessage> = {
  'cli.promote.kind_unsupported': {
    zh: 'promote 暂仅支持 kind=skill；收到 {kind}。',
    en: 'promote supports only kind=skill today; got {kind}.',
  },
  'cli.promote.not_managed': {
    zh: '未找到受管记录 {name}（kind={kind}）。先用 omk install 纳管、omk eval 取证，再 promote。',
    en: 'No managed record {name} (kind={kind}). Run omk install to register, omk eval to gather evidence, then promote.',
  },
  'cli.promote.blocked_header': {
    zh: 'promote 被门禁拦下（{name}）：',
    en: 'promote was blocked by the gate ({name}):',
  },
  'cli.promote.drifted': {
    zh: '· 源已漂移或不可达：当前源内容与受管基线不一致，证据对应的是旧内容。重跑 omk eval 重新取证。',
    en: '· source drifted or unreachable: current source content differs from the managed baseline; the evidence is for old content. Re-run omk eval.',
  },
  'cli.promote.no_current_evidence': {
    zh: '· 当前内容没有评测证据，无法 promote（force 也不行）。先跑 omk eval 取证（omk list 看证据状态）。',
    en: '· no evaluation evidence for the current content; cannot promote (not even with --force). Run omk eval first (omk list shows evidence status).',
  },
  'cli.promote.incomparable': {
    zh: '· 证据的评委提示词指纹 {judgePromptHash} 不是当前评委：judge prompt 已变、旧 verdict 不可比。重跑 omk eval。',
    en: '· evidence judge-prompt fingerprint {judgePromptHash} is not the current judge: the judge prompt changed, the old verdict is incomparable. Re-run omk eval.',
  },
  'cli.promote.incomparable_unverified': {
    zh: '⚠️ 证据缺评委提示词指纹，无法核对可比性（按未核处理，不拦门禁）。',
    en: '⚠️ evidence has no judge-prompt fingerprint; comparability cannot be verified (treated as unchecked, not blocking).',
  },
  'cli.promote.verdict_blocked': {
    zh: '· 当前证据 verdict={verdict}，不在接受集（默认仅 PROGRESS；CAUTIOUS 需 --accept-cautious）。',
    en: '· current evidence verdict={verdict} is not in the accepted set (default PROGRESS only; CAUTIOUS needs --accept-cautious).',
  },
  'cli.promote.force_hint': {
    zh: '如确需越门，加 --force 并用 --reason 写明理由（会记为人工 override 决定）。',
    en: 'To override anyway, pass --force with --reason (recorded as a human override decision).',
  },
  'cli.promote.promoted': {
    zh: '已 promote {name}：接受内容 {hash}（verdict={verdict},report={reportId}）。',
    en: 'Promoted {name}: accepted content {hash} (verdict={verdict}, report={reportId}).',
  },
  'cli.promote.forced_override': {
    zh: '⚠️ 已 --force 越门 promote {name}：接受内容 {hash}（被越过的 verdict={verdict}）。越门已记为人工决定。',
    en: '⚠️ force-promoted {name}: accepted content {hash} (overridden verdict={verdict}). The override is recorded as a human decision.',
  },
  'cli.promote.already_promoted': {
    zh: '{name} 的当前内容已 promote 过，无需重复（幂等，未改动记录）。',
    en: '{name} current content is already promoted; nothing to do (idempotent, record untouched).',
  },
};
