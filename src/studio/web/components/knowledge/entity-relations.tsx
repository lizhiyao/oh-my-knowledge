'use client';
import Link from 'next/link';
import { Alert, Button, Input, Select, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeEntityAnalysisDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_ENTITIES_PATH } from '../../../http/page-paths';
import { displayTime } from '../../../application/display/format';

type Revision = KnowledgeEntityAnalysisDetail['revision'];
type Entity = Revision['entities'][number];
type Mention = Revision['mentions'][number];

export function referentLabel(kind: Entity['referentKind'], lang: Language) {
  return ({ object: ['对象', 'Object'], component: ['组件', 'Component'], instance: ['实例', 'Instance'],
    version: ['版本', 'Version'], collection: ['集合', 'Collection'], plan: ['计划', 'Plan'], activity: ['活动', 'Activity'] })[kind][lang === 'zh' ? 0 : 1];
}
const completenessLabel = (value: NonNullable<Entity['collection']>['completeness'], lang: Language) =>
  ({ complete: ['成员完整', 'Complete membership'], partial: ['仅部分成员已知', 'Partial membership'], unknown: ['成员未知', 'Unknown membership'] })[value][lang === 'zh' ? 0 : 1];

/** Human-readable explanations of shared domain validation codes; no alternate admission rules. */
export function identityProblemLabel(code: string, lang: Language): string {
  const labels: Record<string, [string, string]> = {
    unexpected_component_reference: ['仅实例或版本可关联组件；请修改对象层次或移除关联。', 'Only instances or versions can link a component. Change the level or remove the link.'],
    invalid_collection_shape: ['集合必须有成员信息；其他对象请移除集合信息。', 'Collections need membership information; remove it from other entity levels.'],
    duplicate_collection_member: ['集合成员不能重复。', 'Collection members must be unique.'],
    unknown_collection_has_members: ['成员未知时不能列出确定成员；请移除成员或修改完整性。', 'Unknown membership cannot contain definite members. Remove them or change completeness.'],
    partial_collection_without_members: ['仅部分成员已知时，至少选择一个已知成员。', 'Partial membership needs at least one known member.'],
    incomplete_collection_without_reason: ['成员不完整或未知时，请填写不确定性与理由。', 'Partial or unknown membership needs an uncertainty reason.'],
    unresolved_collection_has_membership: ['身份有歧义的集合必须保留成员未知。', 'An unresolved collection must retain unknown membership.'],
    possible_entity_level_mismatch: ['可能对应的对象须处于相同层次。', 'Possible identities must have the same referent level.'],
    unknown_component: ['关联组件已不存在；请重新选择或移除关联。', 'The linked component is missing. Choose another or remove the link.'],
    invalid_component_target: ['关联目标须是身份已提出的组件。', 'The link target must be a proposed component.'],
    possible_component_mismatch: ['可能对应的实例或版本属于不同组件；请核对候选或组件关联。', 'Possible instances or versions link different components. Check candidates or the component link.'],
    unknown_collection_member: ['集合含已不存在的成员；请纠正成员列表。', 'A collection member is missing. Correct the member list.'],
    collection_cycle: ['集合不能直接或间接包含自己；请纠正成员列表。', 'A collection cannot contain itself directly or indirectly. Correct membership.'],
    'component:duplicate_mention': ['组件依据不能重复。', 'Component evidence must be unique.'],
    'component:unknown_mention': ['组件依据已不存在；请重新选择依据。', 'Component evidence is missing. Select evidence again.'],
    'component:missing_entity_mention': ['组件依据至少包含当前实例或版本自己的提及。', 'Component evidence must include a mention of this instance or version.'],
    'collection:duplicate_mention': ['集合依据不能重复。', 'Collection evidence must be unique.'],
    'collection:unknown_mention': ['集合依据已不存在；请重新选择依据。', 'Collection evidence is missing. Select evidence again.'],
    'collection:missing_entity_mention': ['集合依据至少包含当前集合自己的提及。', 'Collection evidence must include a mention of this collection.'],
  };
  return labels[code]?.[lang === 'zh' ? 0 : 1] ?? (lang === 'zh' ? '请核对对象的关联与依据。' : 'Check the entity links and evidence.');
}

/** Edits retain other fields until the user explicitly corrects them, including temporarily invalid drafts. */
export function EntityRelationFields({ entity, entities, mentions, editable, sourceAvailable, lang, onChange, onInspect }: {
  entity: Entity; entities: Entity[]; mentions: Mention[]; editable: boolean; sourceAvailable: boolean; lang: Language;
  onChange(patch: Partial<Entity>): void; onInspect(mention: Mention): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const entityOptions = entities.map(value => ({ value: value.entityId, label: `${value.label || '—'} · ${value.qualifiers.join(' / ') || referentLabel(value.referentKind, lang)} · ${value.entityId.slice(-8)}` }));
  const evidenceOptions = mentions.map(mention => ({ value: mention.mentionId,
    label: `${entities.find(value => value.entityId === mention.entityId)?.label || '—'} · “${mention.selection.quote}” · ${mention.selection.evidenceRef.slice(-8)} · ${mention.selection.start}–${mention.selection.end}` }));
  function evidence(link: NonNullable<Entity['componentRef']> | NonNullable<Entity['collection']>, change: (patch: { mentionIds?: string[]; rationale?: string }) => void) {
    return <>
      <label>{t('判断依据（至少一处属于当前对象）', 'Evidence (include a mention of this entity)')}<Select mode="multiple" optionFilterProp="label" disabled={!editable} value={link.mentionIds}
        options={evidenceOptions} onChange={mentionIds => change({ mentionIds })}/></label>
      <SpaceEvidence mentions={mentions.filter(value => link.mentionIds.includes(value.mentionId))} disabled={!sourceAvailable} lang={lang} onInspect={onInspect}/>
      <label>{t('关联判断理由', 'Link rationale')}<Input.TextArea disabled={!editable} rows={2} value={link.rationale} onChange={event => change({ rationale: event.target.value })}/></label>
    </>;
  }
  return <>
    <label>{t('对象层次', 'Referent level')}<Select disabled={!editable} value={entity.referentKind} options={(['object', 'component', 'instance', 'version', 'collection', 'plan', 'activity'] as const)
      .map(value => ({ value, label: referentLabel(value, lang) }))} onChange={referentKind => onChange({ referentKind,
        ...(referentKind === 'collection' && !entity.collection ? { collection: { memberEntityIds: [], completeness: 'unknown', mentionIds: [], rationale: '' } } : {}) })}/></label>
    {(['instance', 'version'].includes(entity.referentKind) || entity.componentRef) && <section className="entity-relation">
      <h4>{t('关联组件', 'Linked component')}</h4>
      <Select aria-label={t('选择关联组件', 'Choose linked component')} disabled={!editable} value={entity.componentRef?.entityId} style={{ width: '100%' }}
        placeholder={t('尚未关联组件', 'No component linked')} options={entityOptions.filter(option => entities.some(value => value.entityId === option.value && value.referentKind === 'component' && value.identityStatus === 'proposed'))}
        onChange={entityId => onChange({ componentRef: entity.componentRef ? { ...entity.componentRef, entityId } : { entityId, mentionIds: [], rationale: '' } })}/>
      {entity.componentRef && <>{evidence(entity.componentRef, patch => onChange({ componentRef: { ...entity.componentRef!, ...patch } }))}
        <Button disabled={!editable} onClick={() => onChange({ componentRef: null })}>{t('移除组件关联', 'Remove component link')}</Button></>}
    </section>}
    {(entity.referentKind === 'collection' || entity.collection) && <section className="entity-relation"><h4>{t('集合成员', 'Collection members')}</h4>
      {entity.collection ? <>
        <label>{t('成员完整性', 'Membership completeness')}<Select disabled={!editable} value={entity.collection.completeness} options={(['complete', 'partial', 'unknown'] as const)
          .map(value => ({ value, label: completenessLabel(value, lang) }))} onChange={completeness => onChange({ collection: { ...entity.collection!, completeness } })}/></label>
        <label>{t('已知成员', 'Known members')}<Select mode="multiple" optionFilterProp="label" disabled={!editable} value={entity.collection.memberEntityIds} options={entityOptions.filter(value => value.value !== entity.entityId)}
          onChange={memberEntityIds => onChange({ collection: { ...entity.collection!, memberEntityIds } })}/></label>
        {evidence(entity.collection, patch => onChange({ collection: { ...entity.collection!, ...patch } }))}
        <Button disabled={!editable} onClick={() => onChange({ collection: null })}>{t('移除集合信息', 'Remove collection information')}</Button>
      </> : <Button disabled={!editable} onClick={() => onChange({ collection: { memberEntityIds: [], completeness: 'unknown', mentionIds: [], rationale: '' } })}>{t('补充集合信息', 'Add membership information')}</Button>}
      <p className="candidate-help">{t('完整性和成员须分别核对。集合判断不会自动分配给每个成员。', 'Check completeness and members separately. A collection claim is not automatically assigned to each member.')}</p>
    </section>}
  </>;
}
function SpaceEvidence({ mentions, disabled, lang, onInspect }: { mentions: Mention[]; disabled: boolean; lang: Language; onInspect(mention: Mention): void }) {
  return <div className="entity-relation-evidence">{mentions.map(mention => <Button size="small" disabled={disabled} key={mention.mentionId} onClick={() => onInspect(mention)}>
    {lang === 'zh' ? '定位依据：' : 'Locate evidence: '}{mention.selection.quote}</Button>)}</div>;
}

/** All links stay in this exact analysis revision; navigating them does not inherit knowledge claims. */
export function EntityRelations({ detail, entity, workspace, lang }: {
  detail: KnowledgeEntityAnalysisDetail; entity: Entity; workspace: string; lang: Language;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const { revision, history } = detail;
  function link(id: string) {
    const target = revision.entities.find(value => value.entityId === id)!;
    return <Link className="entity-possible-link" key={id} href={`${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace, analysis: history.analysisId, entity: id, revision: revision.revisionId })}`}>
      {target.label} {target.qualifiers.join(' / ')}</Link>;
  }
  function evidence(ids: string[], rationale: string) {
    return <><p>{rationale}</p>{ids.map(id => {
      const mention = revision.mentions.find(value => value.mentionId === id)!;
      const excerpt = detail.source.status === 'available' ? detail.source.excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef) : undefined;
      const matches = excerpt?.text.slice(mention.selection.start, mention.selection.end) === mention.selection.quote;
      return <section className="entity-mention" key={id}><p>{t('判断依据：', 'Evidence: ')}<Tag>{mention.basis === 'explicit' ? t('明确提及', 'Explicit mention') : t('推断对应', 'Inferred assignment')}</Tag><q>{mention.selection.quote}</q> · {link(mention.entityId)}</p><p>{mention.rationale}</p>
        {excerpt && <><p className="candidate-help">{t('来源消息', 'Source message')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind}{excerpt.timestamp ? ` · ${displayTime(excerpt.timestamp)}` : ''}</p>
          {!matches && <Alert type="warning" title={t('依据与快照位置不匹配，不能当作已核对。', 'Evidence does not match the snapshot span; it is not verified.')}/>}
          <details><summary>{t('展开关联依据原文', 'Show original link evidence')}</summary><pre>{matches ? <>{excerpt.text.slice(0, mention.selection.start)}<mark>{mention.selection.quote}</mark>{excerpt.text.slice(mention.selection.end)}</> : excerpt.text}</pre></details></>}
      </section>;
    })}</>;
  }
  const instances = revision.entities.filter(value => value.componentRef?.entityId === entity.entityId);
  const collections = revision.entities.filter(value => value.collection?.memberEntityIds.includes(entity.entityId));
  return <div className="entity-relations"><Tag>{referentLabel(entity.referentKind, lang)}</Tag>
    {entity.componentRef && <section className="entity-relation"><h3>{t('关联组件', 'Linked component')}</h3>{link(entity.componentRef.entityId)}{evidence(entity.componentRef.mentionIds, entity.componentRef.rationale)}</section>}
    {entity.collection && <section className="entity-relation"><h3>{t('集合成员', 'Collection members')} · {completenessLabel(entity.collection.completeness, lang)}</h3>
      {entity.collection.memberEntityIds.map(link)}{!entity.collection.memberEntityIds.length && <p>{entity.collection.completeness === 'unknown' ? t('尚不能确定成员。', 'Members cannot be determined yet.') : t('没有列出的成员。', 'No listed members.')}</p>}
      <p className="candidate-help">{t('集合的知识不会自动归属每个成员。', 'Collection knowledge is not automatically attributed to each member.')}</p>
      {evidence(entity.collection.mentionIds, entity.collection.rationale)}</section>}
    {!!instances.length && <section className="entity-relation"><h3>{t('关联的实例／版本', 'Linked instances / versions')}</h3>{instances.map(value => link(value.entityId))}</section>}
    {!!collections.length && <section className="entity-relation"><h3>{t('所属集合', 'Member of collections')}</h3>{collections.map(value => link(value.entityId))}</section>}
    {(entity.componentRef || entity.collection || instances.length || collections.length) ? <p className="candidate-help">{t('以上关联仅限此来源窗口和所选修订，是待核对的来源判断。', 'These links belong to this source window and selected revision; their interpretations need review.')}</p> : null}
  </div>;
}
