export interface SkillHardRule {
  id: string;
  rule: string;
  expectedBehavior: string;
}

export interface SkillWorkflowNode {
  id: string;
  action: string;
}

export interface SkillWorkflow {
  id: string;
  description?: string;
  source?: 'frontmatter' | 'markdown_headings';
  nodes: SkillWorkflowNode[];
}

export interface SkillFrontmatterParseResult {
  hasFrontmatter: boolean;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface SkillHardRulesValidationResult {
  ok: boolean;
  hasFrontmatter: boolean;
  declared: boolean;
  rules: SkillHardRule[];
  errors: string[];
}

export interface SkillWorkflowsValidationResult {
  ok: boolean;
  hasFrontmatter: boolean;
  declared: boolean;
  workflows: SkillWorkflow[];
  errors: string[];
}
