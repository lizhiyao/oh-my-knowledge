import type { ComposerRule, DoctorRuleLike } from './contracts.js';

export function isComposerRule(rule: DoctorRuleLike): rule is ComposerRule {
  return (rule as ComposerRule).ruleKind === 'composer';
}
