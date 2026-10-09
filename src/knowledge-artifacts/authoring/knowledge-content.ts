import yaml from 'js-yaml';
import type { KnowledgeRevision } from '../../knowledge/contracts.js';
import type { KnowledgeGrounding } from '../../knowledge/store.js';
import type { AuthoredArtifactKind } from './library-contracts.js';

export interface CarrierKnowledge { revision: KnowledgeRevision; grounding: KnowledgeGrounding; sourceWarnings: string[] }

/** Render reviewed material without inventing instructions, time bounds or verification. */
export function renderCarrierKnowledge(items: CarrierKnowledge[], lang: 'zh' | 'en'): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const literal = (value: string) => value.replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
  const field = (name: string, values: string[]) => `${name}：${values.length ? values.map(literal).join('；') : t('未记录', 'Not recorded')}`;
  return items.map(({ revision: r, grounding: g, sourceWarnings }) => {
    const entity = (id: string) => literal(r.entities.find(item => item.entityId === id)?.label ?? id);
    const time = (value: KnowledgeRevision['content']['statements'][number]['context']['occurredDuring']) => JSON.stringify(value);
    const lines = [`### ${literal(r.title)}`, `${t('组织形式', 'Form')}：${({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[r.content.organization.knowledgeKind]}`, `${t('使用前核对适用范围；保留表示愿意维护，不代表已证实。', 'Check applicability before use. Retained content is not verified.')}`];
    const organization = r.content.organization;
    if (organization.knowledgeKind === 'case') lines.push(field(t('案例场景', 'Case situation'), [organization.situation]), field(t('案例缺口', 'Case gaps'), organization.gaps));
    if (organization.knowledgeKind === 'method') lines.push(field(t('方法目的', 'Purpose'), [organization.purpose]));
    for (const s of r.content.statements) {
      const roles = organization.knowledgeKind === 'case' ? [organization.actionStatementIds.includes(s.statementId) ? t('行动', 'Action') : '', organization.outcomeStatementIds.includes(s.statementId) ? t('结果', 'Outcome') : ''].filter(Boolean) : organization.knowledgeKind === 'method' && organization.instructionStatementIds.includes(s.statementId) ? [t('方法步骤', 'Instruction')] : [];
      if (roles.length) lines.push(field(t('作用', 'Role'), roles));
      lines.push(`\n- ${entity(s.subject.entityId)} ${literal(s.relation)}${s.object ? ` ${entity(s.object.entityId)}` : ''}`, `  ${t('陈述含义', 'Claim classification')}：${({ descriptive: t('描述', 'Description'), normative: t('规范要求', 'Normative requirement'), capability: t('能力', 'Capability'), permission: t('许可', 'Permission') })[s.modality]} / ${s.polarity === 'positive' ? t('肯定陈述', 'Positive claim') : t('否定陈述', 'Negative claim')}`, `  ${field(t('场景', 'Scenario'), [s.context.scenario])}`, `  ${field(t('条件', 'Conditions'), s.context.conditions)}`, `  ${field(t('例外', 'Exceptions'), s.context.exceptions)}`, `  ${field(t('未知项', 'Unknowns'), s.context.unknowns)}`, `  ${t('发生时间', 'Occurrence')}：${literal(time(s.context.occurredDuring))}`, `  ${t('适用时间', 'Validity')}：${literal(time(s.context.validDuring))}`);
      for (const e of r.evidence.filter(link => link.statementIds.includes(s.statementId))) {
        const citation = g.citations.find(item => item.evidenceLinkId === e.evidenceLinkId);
        lines.push(`  ${t('依据', 'Evidence')}：${({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[e.basis]} / ${({ supports: t('支持', 'Supports'), opposes: t('反对', 'Opposes'), background: t('背景', 'Background') })[e.relation]}；${literal(e.interpretation)}`);
        if (citation) lines.push(`  ${t('原文', 'Quote')}：${literal(citation.selection.quote)} (${citation.selection.evidenceRef}, ${citation.selection.start}–${citation.selection.end})`);
      }
    }
    lines.push(`\n${field(t('复用用途', 'Potential use'), [g.reuseRationale])}`, field(t('身份不确定性', 'Identity uncertainties'), g.identityUncertainties), `${t('知识修订', 'Knowledge revision')}：${r.knowledgeId} / ${r.revisionId}`);
    for (const binding of g.sourceBindings) lines.push(`${t('来源版本', 'Source version')}：${binding.snapshotId} / ${binding.sourceVersion}`);
    for (const warning of sourceWarnings) lines.push(`${t('来源限制', 'Source limitation')}：${literal(warning)}`);
    return lines.join('\n\n');
  }).join('\n\n');
}

export function composeCarrierContent(name: string, directoryName: string, artifactKind: AuthoredArtifactKind, material: string, baseContent: string, lang: 'zh' | 'en'): string {
  const title = name.replace(/[\r\n]/g, ' ');
  const heading = lang === 'zh' ? '从工作记录保留的知识' : 'Knowledge retained from work records';
  const base = baseContent || (artifactKind === 'skill'
    ? `---\nname: ${JSON.stringify(directoryName)}\ndescription: ${JSON.stringify(lang === 'zh' ? `${title}：处理相关任务时参考已核对的工作经验，使用前核对适用条件与来源。` : `${title}: use reviewed work knowledge for related tasks after checking conditions and sources.`)}\n---\n\n# ${title}\n`
    : `# ${title}\n`);
  if (!material) return base;
  return `${base}${base.endsWith('\n') ? '' : '\n'}\n## ${heading}\n\n${material}\n`;
}

/** Display names stay human-readable; actual skill directories obey the portable skill name contract. */
export function chooseCarrierDirectory(name: string, id: string, kind: AuthoredArtifactKind, baseContent: string): string {
  if (kind === 'skill' && baseContent) {
    try {
      const match = baseContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata = match ? yaml.load(match[1]) as { name?: unknown } | null : null;
      if (typeof metadata?.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) && metadata.name.length <= 64) return metadata.name;
    } catch { /* Invalid imported metadata remains visible for the user's review. */ }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/g, '') || 'knowledge';
  return `${slug}-${id}`;
}
export function validateCarrierSkill(content: string, directoryName: string): void {
  try {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = match ? yaml.load(match[1]) as { name?: unknown; description?: unknown } | null : null;
    if (!metadata || metadata.name !== directoryName || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) throw new Error();
  } catch { throw new Error('carrier_invalid_skill'); }
}
