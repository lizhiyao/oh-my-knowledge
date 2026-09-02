export interface DependencyRequirements {
  tools?: string[];
  files?: string[];
  env?: string[];
  preflight?: string[];
}

export type DependencyReasonCode =
  | 'tool_not_found'
  | 'file_not_found'
  | 'env_not_set'
  | 'preflight_failed';

export interface DependencyIssue {
  category: 'tool' | 'file' | 'env' | 'preflight';
  name: string;
  /** Stable enum so consumers (doctor, eval-pipeline) translate per their own lang.
   *  The dep-checker itself never produces user-facing strings — it only carries facts. */
  reasonCode: DependencyReasonCode;
  /** Optional untranslated raw context: stderr line, cwd, command — surfaces at the
   *  consumer's UI layer so the actual failure is visible without round-tripping the
   *  process. Never localized; pass through verbatim. */
  reasonDetail?: string;
}

export interface DependencyCheckResult {
  ok: boolean;
  missing: DependencyIssue[];
}
