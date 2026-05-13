import yaml from 'js-yaml';

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

interface YamlErrorLike {
  mark?: { line: number };
  reason?: string;
  message?: string;
}

const HARD_RULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WORKFLOW_ID_RE = HARD_RULE_ID_RE;

export function parseSkillFrontmatter(content: string): SkillFrontmatterParseResult {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { hasFrontmatter: false, ok: true, data: {} };
  try {
    const loaded = yaml.load(match[1]);
    if (loaded === undefined || loaded === null) return { hasFrontmatter: true, ok: true, data: {} };
    if (!isPlainObject(loaded)) {
      return { hasFrontmatter: true, ok: false, error: 'front-matter must be a YAML mapping' };
    }
    return { hasFrontmatter: true, ok: true, data: loaded as Record<string, unknown> };
  } catch (err: unknown) {
    const e = (typeof err === 'object' && err !== null ? err : {}) as YamlErrorLike;
    const lineSuffix = e.mark ? ` at line ${e.mark.line + 1}` : '';
    return { hasFrontmatter: true, ok: false, error: `${e.reason || e.message || 'YAML parse error'}${lineSuffix}` };
  }
}

export function validateSkillHardRules(content: string): SkillHardRulesValidationResult {
  const parsed = parseSkillFrontmatter(content);
  if (!parsed.ok) {
    return {
      ok: false,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: false,
      rules: [],
      errors: [parsed.error ?? 'front-matter parse error'],
    };
  }

  const value = parsed.data?.hardRules;
  if (value === undefined) {
    return {
      ok: true,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: false,
      rules: [],
      errors: [],
    };
  }

  const errors: string[] = [];
  const rules: SkillHardRule[] = [];
  const seenIds = new Set<string>();

  if (!Array.isArray(value)) {
    return {
      ok: false,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: true,
      rules: [],
      errors: ['hardRules must be a YAML list'],
    };
  }

  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`hardRules[${index}] must be an object with id, rule, expectedBehavior`);
      return;
    }
    const raw = item as Record<string, unknown>;
    const id = stringField(raw.id);
    const rule = stringField(raw.rule);
    const expectedBehavior = stringField(raw.expectedBehavior);

    if (!id) {
      errors.push(`hardRules[${index}].id is required`);
    } else if (!HARD_RULE_ID_RE.test(id)) {
      errors.push(`hardRules[${index}].id must use letters, numbers, "_", "-", or "." and contain no spaces`);
    } else if (seenIds.has(id)) {
      errors.push(`hardRules[${index}].id duplicates "${id}"`);
    }

    if (!rule) errors.push(`hardRules[${index}].rule is required`);
    if (!expectedBehavior) errors.push(`hardRules[${index}].expectedBehavior is required`);

    if (id && HARD_RULE_ID_RE.test(id) && rule && expectedBehavior && !seenIds.has(id)) {
      rules.push({ id, rule, expectedBehavior });
      seenIds.add(id);
    }
  });

  return {
    ok: errors.length === 0,
    hasFrontmatter: parsed.hasFrontmatter,
    declared: true,
    rules,
    errors,
  };
}

export function extractSkillHardRules(content: string): SkillHardRule[] {
  const result = validateSkillHardRules(content);
  return result.ok ? result.rules : [];
}

export function validateSkillWorkflows(content: string): SkillWorkflowsValidationResult {
  const parsed = parseSkillFrontmatter(content);
  if (!parsed.ok) {
    return {
      ok: false,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: false,
      workflows: [],
      errors: [parsed.error ?? 'front-matter parse error'],
    };
  }

  const value = parsed.data?.workflows;
  if (value === undefined) {
    return {
      ok: true,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: false,
      workflows: [],
      errors: [],
    };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      hasFrontmatter: parsed.hasFrontmatter,
      declared: true,
      workflows: [],
      errors: ['workflows must be a YAML list'],
    };
  }

  const errors: string[] = [];
  const workflows: SkillWorkflow[] = [];
  const seenWorkflowIds = new Set<string>();

  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`workflows[${index}] must be an object with id and nodes`);
      return;
    }
    const raw = item as Record<string, unknown>;
    const id = stringField(raw.id);
    const description = stringField(raw.description);
    const nodesValue = raw.nodes ?? raw.steps;
    const nodes: SkillWorkflowNode[] = [];

    if (!id) {
      errors.push(`workflows[${index}].id is required`);
    } else if (!WORKFLOW_ID_RE.test(id)) {
      errors.push(`workflows[${index}].id must use letters, numbers, "_", "-", or "." and contain no spaces`);
    } else if (seenWorkflowIds.has(id)) {
      errors.push(`workflows[${index}].id duplicates "${id}"`);
    }

    if (!Array.isArray(nodesValue) || nodesValue.length === 0) {
      errors.push(`workflows[${index}].nodes must be a non-empty list`);
    } else {
      const seenNodeIds = new Set<string>();
      nodesValue.forEach((node, nodeIndex) => {
        if (!isPlainObject(node)) {
          errors.push(`workflows[${index}].nodes[${nodeIndex}] must be an object with id and action`);
          return;
        }
        const rawNode = node as Record<string, unknown>;
        const nodeId = stringField(rawNode.id);
        const action = stringField(rawNode.action) ?? stringField(rawNode.name) ?? stringField(rawNode.description);
        if (!nodeId) {
          errors.push(`workflows[${index}].nodes[${nodeIndex}].id is required`);
        } else if (!WORKFLOW_ID_RE.test(nodeId)) {
          errors.push(`workflows[${index}].nodes[${nodeIndex}].id must use letters, numbers, "_", "-", or "." and contain no spaces`);
        } else if (seenNodeIds.has(nodeId)) {
          errors.push(`workflows[${index}].nodes[${nodeIndex}].id duplicates "${nodeId}"`);
        }
        if (!action) errors.push(`workflows[${index}].nodes[${nodeIndex}].action is required`);
        if (nodeId && WORKFLOW_ID_RE.test(nodeId) && action && !seenNodeIds.has(nodeId)) {
          nodes.push({ id: nodeId, action });
          seenNodeIds.add(nodeId);
        }
      });
    }

    if (id && WORKFLOW_ID_RE.test(id) && nodes.length > 0 && !seenWorkflowIds.has(id)) {
      workflows.push({ id, ...(description ? { description } : {}), nodes });
      seenWorkflowIds.add(id);
    }
  });

  return {
    ok: errors.length === 0,
    hasFrontmatter: parsed.hasFrontmatter,
    declared: true,
    workflows,
    errors,
  };
}

export function extractSkillWorkflows(content: string): SkillWorkflow[] {
  const result = validateSkillWorkflows(content);
  return result.ok ? result.workflows : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
