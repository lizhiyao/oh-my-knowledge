export type SkillChainAdvisoryCode =
  | 'hardrules_not_declared'
  | 'workflows_not_declared'
  | 'skill_md_not_found';

export interface SkillChainAdvisory {
  code: SkillChainAdvisoryCode;
  message: string;
  exampleYaml?: string;
  commandTemplate?: string;
  shortLabel: string;
}
