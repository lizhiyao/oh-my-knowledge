/** omk eval default shared by CLI parsing and the Core input registry. */
export const DEFAULT_EVALUATION_TIMEOUT_MS = 120_000;

/** Stable 1–5 layer gate default shared by authoring and CLI input compilation. */
export const DEFAULT_EVALUATION_GATE_THRESHOLD = 3.5;

/** Heuristic floor used only when no a priori power assumptions are registered. */
export const DEFAULT_MINIMUM_COMPARISON_UNITS = 20;

/** Conventional planning target; callers can override it in an explicit power plan. */
export const DEFAULT_TARGET_POWER = 0.8;
