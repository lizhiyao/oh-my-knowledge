'use client';
import { Alert, Button, Input, Select, Space } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { sourceCoordinateLabel, sourceTitle } from './source-locator';

type Projection = NonNullable<KnowledgeCandidateDetail['derivedAssociations']['revision']>;
type Relation = NonNullable<Projection['typedRelations']>[number];
type Segment = KnowledgeCandidateDetail['revision']['content']['segments'][number];
type Evidence = Relation['evidence'][number];
type EntityRef = Relation['subject'];
export type AssociationRelationDraft = Omit<Relation, 'subject'> & { subject?: EntityRef };
type RelationProblem = 'segments' | 'subject' | 'object' | 'relation' | 'evidence';
const entityKey = (ref: EntityRef) => JSON.stringify([ref.analysisId, ref.entityRevisionId, ref.entityId]);
const evidenceKey = (item: Evidence) => JSON.stringify([item.source.snapshotId, item.source.sourceVersion, item.selection.evidenceRef,
  item.selection.start, item.selection.end, item.selection.quote, item.basis, item.interpretation ?? null]);
function withinEvidence(item: Evidence, parent: Evidence) {
  return item.source.snapshotId === parent.source.snapshotId && item.source.sourceVersion === parent.source.sourceVersion
    && item.selection.evidenceRef === parent.selection.evidenceRef && item.selection.start >= parent.selection.start
    && item.selection.end <= parent.selection.end && item.selection.end - item.selection.start === item.selection.quote.length
    && parent.selection.quote.slice(item.selection.start - parent.selection.start, item.selection.end - parent.selection.start) === item.selection.quote;
}
function problems(relation: AssociationRelationDraft, segments: Segment[], mappings: Projection['segmentEntityRefs']): RelationProblem[] {
  const selected = segments.filter(segment => relation.segmentIds.includes(segment.segmentId));
  const mapped = mappings.filter(mapping => relation.segmentIds.includes(mapping.segmentId) && mapping.mentionIds.length);
  const has = (ref: EntityRef | undefined) => !!ref && mapped.some(mapping => entityKey(mapping) === entityKey(ref));
  const result: RelationProblem[] = [];
  if (!selected.length || selected.length !== relation.segmentIds.length) result.push('segments');
  if (!has(relation.subject)) result.push('subject');
  if (relation.object && !has(relation.object)) result.push('object');
  if (!relation.relation.trim() || relation.relation.length > 32_768) result.push('relation');
  if (!relation.evidence.length || relation.evidence.some(item => !selected.some(segment => segment.evidence.some(parent => withinEvidence(item, parent))))) result.push('evidence');
  return result;
}

/** Form feedback only; the host remains authoritative for catalog and evidence validation. */
export function associationRelationsReady(relations: AssociationRelationDraft[] | undefined, segments: Segment[], mappings: Projection['segmentEntityRefs']): relations is Relation[] | undefined {
  return !relations || new Set(relations.map(relation => relation.relationId)).size === relations.length
    && relations.every(relation => !problems(relation, segments, mappings).length);
}

export function AssociationRelationEditor({ relations, segments, sources, mappings, entities, locked, lang, onChange }: {
  relations: AssociationRelationDraft[] | undefined; segments: Segment[]; mappings: Projection['segmentEntityRefs'];
  sources: KnowledgeCandidateDetail['sources'];
  entities: { segmentId: string; ref: EntityRef; label: string }[]; locked: boolean; lang: Language;
  onChange(value: AssociationRelationDraft[]): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const basisLabel = (basis: Evidence['basis']) => basis === 'source_assertion' ? t('来源中的说法', 'Source assertion')
    : basis === 'inference' ? t('推断', 'Inference') : t('直接观测', 'Direct observation');
  const sourceKey = (item: Evidence) => JSON.stringify([item.source.snapshotId, item.source.sourceVersion]);
  const sourceKeys = [...new Set(segments.flatMap(segment => segment.evidence.map(sourceKey)))];
  function evidenceLabel(item: Evidence) {
    const sourceIndex = sourceKeys.indexOf(sourceKey(item)) + 1;
    const source = sources.find(value => value.status === 'available' && value.snapshot.snapshotId === item.source.snapshotId && value.snapshot.sourceVersion === item.source.sourceVersion);
    const excerpt = source?.status === 'available' ? source.snapshot.excerpts.find(value => value.evidenceRef === item.selection.evidenceRef) : undefined;
    return `${t('来源', 'Source')} ${sourceIndex}${source?.status === 'available' ? ` · ${sourceTitle(source.snapshot, lang)}` : ''}${excerpt ? ` · ${sourceCoordinateLabel(excerpt.coordinate, lang)}` : ''} · ${item.selection.start}–${item.selection.end} · ${basisLabel(item.basis)} · ${item.selection.quote.slice(0, 90)}${item.interpretation ? ` · ${item.interpretation}` : ''}`;
  }
  const descriptions: Record<RelationProblem, string> = {
    segments: t('请选择本关系涉及的正文段落。', 'Choose the content segments for this relation.'),
    subject: t('主体不在所选段落的有效映射中，请重新选择主体或修正实体映射。', 'The subject is not mapped to the selected segments. Choose a subject or correct its mapping.'),
    object: t('客体不在所选段落的有效映射中，请重新选择客体、清除客体或修正实体映射。', 'The object is not mapped to the selected segments. Choose or clear the object, or correct its mapping.'),
    relation: t('请填写关系描述（不超过 32768 字符）。', 'Enter a relation description (up to 32768 characters).'),
    evidence: t('请选择所选段落内的精确依据；失效的已有依据需明确移除或替换。', 'Choose exact evidence within the selected segments. Explicitly remove or replace existing evidence that no longer belongs.'),
  };
  function update(index: number, patch: Partial<AssociationRelationDraft>) {
    if (!locked) onChange((relations ?? []).map((relation, at) => at === index ? { ...relation, ...patch } : relation));
  }
  return <section className="candidate-form" aria-label={t('实体关系', 'Entity relations')} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h3 className="candidate-form-heading">{t('实体关系', 'Entity relations')}</h3>
    <p className="candidate-help">{t('关系连接已映射的对象，并绑定当前正文段落及其依据。修改映射不会自动删除关系；请逐项修正或删除后保存。新关联仍待核对。', 'Relations connect mapped entities and cite this exact content. Mapping changes do not delete relations automatically. Correct or remove affected relations before saving; new associations remain pending review.')}</p>
    {!(relations?.length) && <p className="candidate-help">{relations === undefined
      ? t('此修订尚未请求关系维护。可以按需要添加。', 'Relation maintenance has not been requested for this revision. Add a relation when needed.')
      : t('本次保存不包含实体关系。', 'This save contains no entity relations.')}</p>}
    {(relations ?? []).map((relation, index) => {
      const selected = segments.filter(segment => relation.segmentIds.includes(segment.segmentId));
      const choices = [...new Map(entities.filter(entity => relation.segmentIds.includes(entity.segmentId)).map(entity => [entityKey(entity.ref), entity])).values()];
      const evidence = [...new Map([...relation.evidence, ...selected.flatMap(segment => segment.evidence)].map(item => [evidenceKey(item), item])).values()];
      const errors = problems(relation, segments, mappings);
      const endpointOptions = (ref?: EntityRef) => [...choices.map(choice => ({ value: entityKey(choice.ref), label: choice.label })),
        ...(ref && !choices.some(choice => entityKey(choice.ref) === entityKey(ref)) ? [{ value: entityKey(ref), label: t('已选对象不可用，请重新选择', 'Selected entity unavailable; choose another'), disabled: true }] : [])];
      return <section className="candidate-form candidate-statement" key={relation.relationId} aria-label={t(`关系 ${index + 1}`, `Relation ${index + 1}`)}>
        <Space wrap><strong>{t(`关系 ${index + 1}`, `Relation ${index + 1}`)}</strong><Button danger disabled={locked} onClick={() => !locked && onChange((relations ?? []).filter((_, at) => at !== index))}>{t(`删除关系 ${index + 1}`, `Remove relation ${index + 1}`)}</Button></Space>
        <label>{t('关联段落', 'Related segments')}<Select mode="multiple" aria-label={t(`关系 ${index + 1} 的段落`, `Segments for relation ${index + 1}`)} disabled={locked} value={relation.segmentIds}
          options={segments.map((segment, at) => ({ value: segment.segmentId, label: `${at + 1} · ${segment.text.slice(0, 100)}` }))}
          onChange={segmentIds => update(index, { segmentIds })}/></label>
        <label>{t('主体', 'Subject')}<Select aria-label={t(`关系 ${index + 1} 的主体`, `Subject for relation ${index + 1}`)} disabled={locked} value={relation.subject && entityKey(relation.subject)} options={endpointOptions(relation.subject)}
          onChange={key => update(index, { subject: choices.find(choice => entityKey(choice.ref) === key)?.ref })}/></label>
        <label>{t('关系描述', 'Relation description')}<Input.TextArea aria-label={t(`关系 ${index + 1} 的描述`, `Description for relation ${index + 1}`)} readOnly={locked} rows={2} value={relation.relation} onChange={event => update(index, { relation: event.target.value })}/></label>
        <label>{t('客体（可选）', 'Object (optional)')}<Select allowClear aria-label={t(`关系 ${index + 1} 的客体`, `Object for relation ${index + 1}`)} disabled={locked} value={relation.object && entityKey(relation.object)} options={endpointOptions(relation.object)}
          onChange={key => update(index, { object: choices.find(choice => entityKey(choice.ref) === key)?.ref })}/></label>
        <label>{t('关系性质', 'Relation modality')}<Select aria-label={t(`关系 ${index + 1} 的性质`, `Modality for relation ${index + 1}`)} disabled={locked} value={relation.modality}
          options={[{ value: 'descriptive', label: t('描述', 'Descriptive') }, { value: 'normative', label: t('规范要求', 'Normative') }, { value: 'capability', label: t('能力', 'Capability') }, { value: 'permission', label: t('许可', 'Permission') }]}
          onChange={modality => update(index, { modality })}/></label>
        <label>{t('肯定或否定', 'Relation polarity')}<Select aria-label={t(`关系 ${index + 1} 的肯否`, `Polarity for relation ${index + 1}`)} disabled={locked} value={relation.polarity}
          options={[{ value: 'positive', label: t('肯定', 'Positive') }, { value: 'negative', label: t('否定', 'Negative') }]} onChange={polarity => update(index, { polarity })}/></label>
        <label>{t('正文内的关系依据', 'Relation evidence within the content')}<Select mode="multiple" aria-label={t(`关系 ${index + 1} 的依据`, `Evidence for relation ${index + 1}`)} disabled={locked} value={relation.evidence.map(evidenceKey)}
          options={evidence.map(item => ({ value: evidenceKey(item), label: evidenceLabel(item) }))}
          onChange={keys => update(index, { evidence: keys.flatMap(key => { const item = evidence.find(value => evidenceKey(value) === key); return item ? [item] : []; }) })}/></label>
        {relation.evidence.map((item, at) => <div key={`${evidenceKey(item)}/${at}`}>
          <p>{item.selection.quote}</p><p className="candidate-help">{basisLabel(item.basis)}{item.interpretation && ` · ${item.interpretation}`}</p>
          <details><summary>{t(`依据 ${at + 1} 的精确身份`, `Exact identity of evidence ${at + 1}`)}</summary><p className="candidate-help" style={{ overflowWrap: 'anywhere' }}><code>{item.source.snapshotId} / {item.source.sourceVersion}<br/>{item.selection.evidenceRef} · {item.selection.start}–{item.selection.end}</code></p></details>
        </div>)}
        {!!relation.issues.length && <div><p className="candidate-help">{t('随关系保留的限制与疑点', 'Limits and issues preserved with this relation')}</p><ul>{relation.issues.map((issue, at) => <li key={at}>{issue}</li>)}</ul></div>}
        <details><summary>{t('关系及所选对象的精确身份', 'Exact relation and entity identities')}</summary><p className="candidate-help" style={{ overflowWrap: 'anywhere' }}><code>{relation.relationId}</code>{[relation.subject, relation.object].filter(ref => ref !== undefined).map((ref, at) => <span key={at}><br/><code>{ref.analysisId} / {ref.entityRevisionId} / {ref.entityId}</code></span>)}</p></details>
        {!!errors.length && <Alert type="warning" title={t('此关系尚不能保存', 'This relation is not ready to save')} description={<ul>{errors.map(error => <li key={error}>{descriptions[error]}</li>)}</ul>}/>}
      </section>;
    })}
    <Button disabled={locked} onClick={() => !locked && onChange([...(relations ?? []), { relationId: crypto.randomUUID(), segmentIds: [], relation: '', modality: 'descriptive', polarity: 'positive', evidence: [], issues: [] }])}>{t('添加实体关系', 'Add an entity relation')}</Button>
  </section>;
}
