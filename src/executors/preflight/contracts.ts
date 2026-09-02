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

/** Minimum artifact facts required by generic host dependency preflight. */
export interface PreflightArtifact {
  readonly content?: string | null;
  readonly skillRoot?: string;
  readonly cwd?: string;
  readonly execRoot?: string;
  readonly locator?: string;
  readonly source?: string;
  readonly metadata?: {
    readonly preflight?: unknown;
  };
}

/** Minimum sample facts required for dependency extraction from assertion values. */
export interface PreflightSample {
  readonly assertions?: readonly {
    readonly value?: unknown;
  }[];
}
