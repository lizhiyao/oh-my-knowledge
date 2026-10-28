import yaml from 'js-yaml';
import type { KnowledgeRevision } from '../../contracts.js';
import type { AuthoredArtifactKind } from './carrier-contracts.js';

export interface CarrierKnowledge { revision: KnowledgeRevision; sourceWarnings: string[]; tagging: { tags: string[] } }

/** Metadata describes exact incorporated body revisions, never their truth or derived links. */
export function carrierMetadata(items: CarrierKnowledge[], kind: AuthoredArtifactKind): Record<string, unknown> {
  const unique = (values: string[]) => [...new Set(values)];
  const tags = [...new Map(items.flatMap(item => item.tagging.tags).map(tag => [tag.toLowerCase(), tag])).values()];
  const evidence = items.flatMap(item => item.revision.content.segments.flatMap(segment => segment.evidence));
  const properties = {
    omk_schema: 'omk-knowledge-metadata/v2', tags,
    summary: items.map(item => item.revision.title).join('；'),
    knowledge_types: unique(items.flatMap(item => item.revision.content.organization ? [item.revision.content.organization.knowledgeKind] : [])),
    evidence_bases: unique(evidence.map(item => item.basis)),
    verification_status: 'not_assessed',
    knowledge_revisions: items.map(item => `${item.revision.knowledgeId}/${item.revision.revisionId}`),
    knowledge_body_digests: items.map(item => item.revision.bodyDigest),
    source_versions: unique(evidence.map(item => `${item.source.snapshotId}/${item.source.sourceVersion}`)),
  };
  return kind === 'prompt' ? properties : { metadata: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.startsWith('omk_') ? key : `omk_${key}`, typeof value === 'string' ? value : JSON.stringify(value)])) };
}

/** Incorporate the complete canonical segments; entity and typed projections never rewrite them. */
export function renderCarrierKnowledge(items: CarrierKnowledge[], lang: 'zh' | 'en'): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const literal = (value: string) => value.replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
  return items.map(({ revision, sourceWarnings }) => {
    const lines = [`### ${literal(revision.title)}`, t('使用前核对适用范围；保留表示愿意维护，不代表已证实。', 'Check applicability before use. Retained content is not verified.')];
    if (revision.content.organization) lines.push(`${t('组织形式', 'Form')}：${({ fact: t('事实', 'Fact'), case: t('案例', 'Case'), method: t('方法', 'Method') })[revision.content.organization.knowledgeKind]}`);
    for (const segment of revision.content.segments) {
      lines.push(literal(segment.text));
      for (const evidence of segment.evidence) {
        const basis = ({ direct_observation: t('直接观测', 'Direct observation'), source_assertion: t('来源中的说法', 'Source assertion'), inference: t('推断', 'Inference') })[evidence.basis];
        lines.push(`${t('依据', 'Evidence')}：${basis}${evidence.interpretation ? `；${literal(evidence.interpretation)}` : ''}`,
          `${t('原文', 'Quote')}：${literal(evidence.selection.quote)} (${evidence.selection.evidenceRef}, ${evidence.selection.start}–${evidence.selection.end})`,
          `${t('来源版本', 'Source version')}：${evidence.source.snapshotId} / ${evidence.source.sourceVersion}`);
      }
    }
    lines.push(`${t('复用用途', 'Potential use')}：${literal(revision.reuseRationale)}`,
      `${t('知识修订', 'Knowledge revision')}：${revision.knowledgeId} / ${revision.revisionId}`,
      `${t('正文摘要', 'Body digest')}：${revision.bodyDigest}`);
    for (const warning of sourceWarnings) lines.push(`${t('来源限制', 'Source limitation')}：${literal(warning)}`);
    return lines.join('\n\n');
  }).join('\n\n');
}

const regionStart = '<!-- omk:knowledge:v1:start -->';
const regionEnd = '<!-- omk:knowledge:v1:end -->';

/** Replace only a managed region. Legacy suffixes must match every exact referenced revision. */
function rebuildKnowledge(base: string, block: string, previousMaterials: string[][]): string {
  const start = base.indexOf(regionStart), end = base.indexOf(regionEnd);
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start || base.indexOf(regionStart, start + 1) !== -1 || base.indexOf(regionEnd, end + 1) !== -1
      || (start > 0 && base[start - 1] !== '\n') || !['', '\n', '\r'].includes(base[end + regionEnd.length] ?? '')) throw new Error('carrier_knowledge_region_conflict');
    const actual = base.slice(start + regionStart.length, end);
    const expected = (['从工作记录保留的知识', 'Knowledge retained from work records']).map((heading, language) => `\n## ${heading}\n\n${previousMaterials.map(values => values[language]).join('\n\n')}\n`);
    if (!expected.includes(actual)) throw new Error('carrier_knowledge_region_conflict');
    return base.slice(0, start) + block + base.slice(end + regionEnd.length);
  }
  if (!previousMaterials.length) return base + (block ? `${base.endsWith('\n') ? '' : '\n'}\n${block}\n` : '');
  const heading = /\n## (?:从工作记录保留的知识|Knowledge retained from work records)\n\n/g;
  const candidates = [...base.matchAll(heading)].slice(0, 1);
  for (const candidate of candidates) {
    let tail = base.slice(candidate.index!); const remaining = new Set(previousMaterials.map((_, index) => index));
    while (tail.trim()) {
      tail = tail.trimStart();
      const section = tail.match(/^## (?:从工作记录保留的知识|Knowledge retained from work records)\n\n/);
      if (section) { tail = tail.slice(section[0].length); continue; }
      const index = [...remaining].find(index => previousMaterials[index].some(value => tail.startsWith(value) && (!tail.slice(value.length) || /^\s/.test(tail.slice(value.length)))));
      if (index === undefined) break;
      const value = previousMaterials[index].find(value => tail.startsWith(value))!;
      tail = tail.slice(value.length); remaining.delete(index);
    }
    if (!tail.trim() && !remaining.size) return base.slice(0, candidate.index! + 1) + (block ? `${block}\n` : '');
  }
  throw new Error('carrier_knowledge_region_conflict');
}

export function composeCarrierContent(name: string, directoryName: string, artifactKind: AuthoredArtifactKind, material: string, baseContent: string, lang: 'zh' | 'en', properties: Record<string, unknown>, previousMaterials?: string[][]): string {
  const title = name.replace(/[\r\n]/g, ' ');
  const heading = lang === 'zh' ? '从工作记录保留的知识' : 'Knowledge retained from work records';
  const original = baseContent || (artifactKind === 'skill'
    ? `---\nname: ${JSON.stringify(directoryName)}\ndescription: ${JSON.stringify(lang === 'zh' ? `${title}：处理相关任务时参考已核对的工作经验，使用前核对适用条件与来源。` : `${title}: use reviewed work knowledge for related tasks after checking conditions and sources.`)}\n---\n\n# ${title}\n`
    : `# ${title}\n`);
  const block = material ? `${regionStart}\n## ${heading}\n\n${material}\n${regionEnd}` : '';
  const base = previousMaterials ? rebuildKnowledge(original, block, previousMaterials) : original + (block ? `${original.endsWith('\n') ? '' : '\n'}\n${block}\n` : '');
  const match = base.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let parsed: unknown;
  try { parsed = match ? yaml.load(match[1]) : {}; } catch { throw new Error('carrier_invalid_metadata'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('carrier_invalid_metadata');
  const previous = parsed as Record<string, unknown>;
  if (artifactKind === 'prompt' && previous.tags != null && (!Array.isArray(previous.tags) || previous.tags.some(tag => typeof tag !== 'string'))) throw new Error('carrier_invalid_metadata');
  if (artifactKind === 'skill' && previous.metadata != null && (typeof previous.metadata !== 'object' || Array.isArray(previous.metadata))) throw new Error('carrier_invalid_metadata');
  const updated: Record<string, unknown> = { ...previous, ...properties, ...(artifactKind === 'prompt' ? { title } : {
    metadata: { ...previous.metadata as Record<string, unknown> | undefined, ...properties.metadata as Record<string, unknown> },
  }) };
  // A generated header is a snapshot of the selected revisions/tags. Imported custom tags are kept on first import.
  if (artifactKind === 'prompt' && previous.omk_schema !== 'omk-knowledge-metadata/v2' && Array.isArray(previous.tags)) {
    updated.tags = [...new Set([...previous.tags.filter((tag): tag is string => typeof tag === 'string'), ...properties.tags as string[]])];
  }
  const prepared = JSON.stringify(previous) === JSON.stringify(updated) ? base
    : `---\n${yaml.dump(updated, { noRefs: true, lineWidth: -1, forceQuotes: true, quotingType: '"' })}---\n${match ? base.slice(match[0].length) : `\n${base}`}`;
  return prepared;
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
