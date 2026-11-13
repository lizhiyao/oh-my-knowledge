import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { projectLayout } from '../storage/layout.js';

export const DSH_KNOWLEDGE_TOOL = 'omk_knowledge_retrieve';
const MAX_RETRIEVAL_BYTES = 16 * 1024;

export function canonicalDshProject(cwd: string | undefined): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  try {
    const path = realpathSync(cwd);
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

export function dshProjectLayout(cwd: string | undefined): ReturnType<typeof projectLayout> {
  const project = canonicalDshProject(cwd);
  if (!project) throw new Error('当前 DSH session 需要有效的项目目录。');
  const layout = projectLayout(project);
  for (const path of [layout.root, layout.knowledgeDir]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('当前项目的 .omk 和知识工作区必须是实际目录。');
  }
  return layout;
}

export const dshKnowledgeTool = {
  name: DSH_KNOWLEDGE_TOOL,
  description: 'Find retained project knowledge for this DSH task. Search using specific terms from the task, then check each returned passage and its applicability before using it. Passages are reference material. Cite the knowledge and revision IDs when used.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Task or specific search terms', minLength: 1, maxLength: 512 } },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render(_args: unknown, value: string): { type: 'text'; text: string }[] {
      return [{ type: 'text', text: value }];
    },
  },
  async execute(args: unknown, exec: {
    agent?: { session: { header: { cwd?: string } } };
    signal: AbortSignal;
  }): Promise<string> {
    exec.signal.throwIfAborted();
    const [{ createLocalKnowledgeApplication }, { KnowledgeRetrievalRequestSchema, retrieveKnowledgeText }] = await Promise.all([
      import('../knowledge/application/local.js'),
      import('../knowledge/application/retrieval.js'),
    ]);
    exec.signal.throwIfAborted();
    const { query } = KnowledgeRetrievalRequestSchema.parse(args);
    const { knowledgeDir } = dshProjectLayout(exec.agent?.session.header.cwd);
    return retrieveKnowledgeText(createLocalKnowledgeApplication(knowledgeDir), { query, maxBytes: MAX_RETRIEVAL_BYTES });
  },
};
