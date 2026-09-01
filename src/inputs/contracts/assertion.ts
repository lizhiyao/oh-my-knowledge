export interface Assertion {
  type: string;
  value?: string | number;
  values?: string[];
  pattern?: string;
  flags?: string;
  schema?: Record<string, unknown>;
  weight?: number;
  fn?: string;
  reference?: string;
  threshold?: number;
  /** When true, a valid assertion pass/fail reading is inverted. Provider
   *  failure, timeout, invalid output, and missing input remain failures.
   *  Works with any type, including legacy `not_contains` (which becomes a
   *  redundant but still supported double-negation). */
  not?: boolean;
  /** Only used by type='assert-set'. 'any' = at least one child must pass;
   *  'all' = every child must pass. Children may be any assertion type,
   *  including nested assert-sets. */
  mode?: 'any' | 'all';
  children?: Assertion[];
  /** For rouge_n_min: which n-gram order (default 1). */
  n?: number;
}
