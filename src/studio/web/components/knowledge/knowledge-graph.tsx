'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Empty, Space } from 'antd';
import type { KnowledgeGraph, KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import type { KnowledgeReaderEntityTarget, KnowledgeReaderSelection } from './reader';
import { conversationPath } from '../conversation-link';
import { workspaceHref } from '../layout/workspace-link';

type Node = KnowledgeGraph['nodes'][number];
type Edge = KnowledgeGraph['edges'][number];
type KnowledgeNode = Extract<Node, { nodeKind: 'knowledge' }>;
type EntityNode = Extract<Node, { nodeKind: 'entity' }>;
type SourceNode = Extract<Node, { nodeKind: 'source' }>;
type Selection = { evidenceRef: string; quote: string; start: number; end: number };
type Citation = { source?: SourceNode; selection: Selection; basis: string; rationale?: string; positionStatus?: string; mentionId?: string; relationId?: string; catalogRef?: KnowledgeReaderSelection['catalogRef'] };

function nodeLabel(node: Node, lang: Language) {
  return node.nodeKind === 'knowledge' ? node.title : node.nodeKind === 'entity' ? node.label
    : node.origin?.title || (lang === 'zh' ? '来源窗口' : 'Source window');
}
function kindLabel(node: Node, lang: Language) {
  return lang === 'zh' ? ({ knowledge: '知识', entity: '实体', source: '来源' })[node.nodeKind]
    : ({ knowledge: 'Knowledge', entity: 'Entity', source: 'Source' })[node.nodeKind];
}
function edgeLabel(edge: Edge, lang: Language) {
  if (edge.edgeKind === 'typed_relation') return edge.relation;
  const labels: Record<string, [string, string]> = {
    source_evidence: ['正文依据', 'Content evidence'], segment_entity: ['段落涉及对象', 'Segment concerns entity'],
    entity_mention: ['原文提及', 'Source mention'], component: ['组件关联', 'Component link'], collection: ['集合成员', 'Collection member'],
    possible_identity: ['可能对应', 'Possible identity'], revision_parent: ['历史修订', 'Revision history'],
  };
  return labels[edge.edgeKind]?.[lang === 'zh' ? 0 : 1] ?? edge.edgeKind;
}
function associationLabel(status: string, lang: Language) {
  const labels: Record<string, [string, string]> = { available: ['有可读关联', 'Associations available'], failed: ['关联未完成', 'Associations incomplete'],
    stale: ['关联对应旧正文', 'Associations bind older content'], absent: ['尚无关联', 'No associations'] };
  return labels[status]?.[lang === 'zh' ? 0 : 1] ?? status;
}
function edgeStateLabel(edge: Edge, lang: Language) {
  if (edge.edgeKind === 'revision_parent') return lang === 'zh' ? '仅表示修订前后沿袭，不是知识关系或身份确认。' : 'Revision lineage only; not a knowledge relationship or identity confirmation.';
  const bodyEdge = edge.edgeKind === 'segment_entity' || edge.edgeKind === 'typed_relation' || edge.edgeKind === 'source_evidence';
  if (bodyEdge) return edge.current ? (lang === 'zh' ? '当前正文的关联' : 'Link for the current content')
    : (lang === 'zh' ? '历史或已替换的关联；不会自动应用到当前正文' : 'Historical or replaced link; not automatically applied to current content');
  return edge.current ? (lang === 'zh' ? '当前实体修订中的来源判断' : 'Source judgment in the current entity revision')
    : (lang === 'zh' ? '原绑定实体修订中的来源判断；目录已有更新' : 'Source judgment in the original entity revision; the catalog has changed');
}
function gapLabel(gap: KnowledgeGraph['coverage']['gaps'][number], lang: Language) {
  if (lang !== 'zh') return gap.detail;
  const labels: Record<string, string> = { knowledge_list_unavailable: '知识目录不可读，图谱覆盖不完整。', knowledge_unavailable: '部分知识修订不可读。', association_unavailable: '部分关联历史不可读。',
    association_failed: '部分知识的关联未完成。', association_stale: '部分关联对应旧正文，当前正文保持可读。', association_absent: '部分知识尚无关联。', association_rejected: '部分关联已被拒绝，不作为当前关联。',
    catalog_unavailable: '绑定的精确实体目录不可读。', catalog_outdated: '绑定的实体目录已有新修订，需明确核对与应用。', entity_unavailable: '绑定修订中的部分实体不可读。', source_unavailable: '部分精确来源快照不可用。', evidence_mismatch: '部分引文与来源位置不匹配，不能当作已核对。' };
  return labels[gap.gapKind] ?? gap.detail;
}
function knowledgeOwner(graph: KnowledgeGraph, selected: Node | Edge | undefined, preferred?: string): KnowledgeNode | undefined {
  if (!selected) return;
  const nodes = graph.nodes.filter((node): node is KnowledgeNode => node.nodeKind === 'knowledge');
  if ('nodeKind' in selected && selected.nodeKind === 'knowledge') return selected;
  const selectedId = 'nodeId' in selected ? selected.nodeId : undefined;
  const edges = selectedId ? graph.edges.filter(edge => edge.from === selectedId || edge.to === selectedId) : [selected as Edge];
  const direct = nodes.filter(node => edges.some(edge => edge.from === node.nodeId || edge.to === node.nodeId
    || ('knowledgeNodeId' in edge && edge.knowledgeNodeId === node.nodeId)));
  if (direct.length) return direct.find(node => node.bodyRef.knowledgeId === preferred && node.current) ?? direct.find(node => node.current) ?? direct[0];
  const entityIds = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  const connected = nodes.filter(node => graph.edges.some(edge => edge.edgeKind === 'segment_entity' && edge.from === node.nodeId && entityIds.has(edge.to)));
  return connected.find(node => node.bodyRef.knowledgeId === preferred && node.current) ?? connected.find(node => node.current) ?? connected[0];
}

/** Presentation selection only: all identities, statuses and relationships come from the application projection. */
export function KnowledgeGraphView({ graph, lang, activeKnowledgeId, activeRevisionId, selectedId, scope, includeHistory, onScope, onHistory, onSelect }: {
  graph: KnowledgeGraph; lang: Language; activeKnowledgeId?: string; activeRevisionId?: string; selectedId?: string; scope: 'current' | 'filtered'; includeHistory: boolean;
  onScope(value: 'current' | 'filtered'): void; onHistory(value: boolean): void; onSelect(id: string, knowledge?: { knowledgeId: string; revisionId: string }): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const canvasRef = useRef<HTMLDivElement>(null), nodeRefs = useRef(new Map<string, SVGGElement>());
  const focusIntentRef = useRef<{ request: string; target: string; nodeId?: string; selection?: string; complete: boolean } | undefined>(undefined);
  const focusRequest = JSON.stringify([activeKnowledgeId, activeRevisionId, scope, includeHistory]);
  const focus = graph.nodes.find(node => node.nodeKind === 'knowledge' && node.bodyRef.knowledgeId === activeKnowledgeId && (activeRevisionId ? node.bodyRef.revisionId === activeRevisionId : node.current));
  const focusTarget = JSON.stringify([activeKnowledgeId, focus?.nodeKind === 'knowledge' ? focus.bodyRef.revisionId : activeRevisionId, scope, includeHistory]);
  const displayed = scope === 'current' && focus ? new Set([focus.nodeId]) : new Set(graph.nodes.map(node => node.nodeId));
  if (scope === 'current' && focus) {
    for (const edge of graph.edges) if (edge.from === focus.nodeId || edge.to === focus.nodeId || ('knowledgeNodeId' in edge && edge.knowledgeNodeId === focus.nodeId)) {
      displayed.add(edge.from); displayed.add(edge.to);
    }
    const direct = new Set(displayed);
    for (const edge of graph.edges) if (direct.has(edge.from) && (edge.edgeKind === 'component' || edge.edgeKind === 'collection' || edge.edgeKind === 'possible_identity')) displayed.add(edge.to);
    for (const edge of graph.edges) if (edge.edgeKind === 'entity_mention' && displayed.has(edge.from)) displayed.add(edge.to);
  }
  const nodes = graph.nodes.filter(node => displayed.has(node.nodeId));
  const selectedNodeId = nodes.find(node => node.nodeId === selectedId)?.nodeId;
  const edges = graph.edges.filter(edge => displayed.has(edge.from) && displayed.has(edge.to));
  const groups = (['source', 'knowledge', 'entity'] as const).map(kind => nodes.filter(node => node.nodeKind === kind));
  const height = Math.max(...groups.map(group => group.length), 1) * 76 + 70;
  const positions = new Map(groups.flatMap((group, column) => group.map((node, index) => [node.nodeId,
    { x: 110 + column * 235, y: 64 + index * 76 + Math.max(0, (height - 70 - group.length * 76) / 2) }] as const)));
  useEffect(() => {
    const previous = focusIntentRef.current;
    if (previous?.request !== focusRequest) focusIntentRef.current = { request: focusRequest, target: focusTarget, nodeId: focus?.nodeId, selection: previous?.selection, complete: previous?.target === focusTarget && previous.complete };
    else if (previous && focus) { previous.target = focusTarget; if (!previous.selection) previous.nodeId = focus.nodeId; }
    const intent = focusIntentRef.current, canvas = canvasRef.current;
    if (intent && intent.selection !== selectedNodeId) {
      intent.selection = selectedNodeId;
      if (selectedNodeId) { intent.nodeId = selectedNodeId; intent.complete = false; }
      else if (intent.nodeId !== focus?.nodeId) intent.complete = true;
    }
    if (!intent || intent.complete || !canvas || !intent.nodeId || !nodeRefs.current.has(intent.nodeId)) return;
    let disposed = false, observer: ResizeObserver | undefined;
    const reveal = () => {
      const target = nodeRefs.current.get(intent.nodeId!);
      if (disposed || intent.complete || !target || !canvas.clientWidth || !canvas.clientHeight) return false;
      const viewport = canvas.getBoundingClientRect(), bounds = target.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return false;
      const top = viewport.top + canvas.clientTop, left = viewport.left + canvas.clientLeft;
      if (bounds.top < top || bounds.bottom > top + canvas.clientHeight) canvas.scrollTop += bounds.top + bounds.height / 2 - top - canvas.clientHeight / 2;
      if (bounds.left < left || bounds.right > left + canvas.clientWidth) canvas.scrollLeft += bounds.left + bounds.width / 2 - left - canvas.clientWidth / 2;
      intent.complete = true;
      observer?.disconnect();
      return true;
    };
    if (!reveal()) {
      observer = new ResizeObserver(reveal);
      observer.observe(canvas);
    }
    return () => { disposed = true; observer?.disconnect(); };
  }, [focusRequest, focusTarget, focus, graph, selectedNodeId]);
  const choose = (id: string) => {
    const selected = graph.nodes.find(node => node.nodeId === id) ?? graph.edges.find(edge => edge.edgeId === id);
    const owner = knowledgeOwner(graph, selected, activeKnowledgeId);
    onSelect(id, owner ? { knowledgeId: owner.bodyRef.knowledgeId, revisionId: owner.bodyRef.revisionId } : undefined);
  };
  return <section className="knowledge-network" aria-label={t('知识图谱', 'Knowledge graph')}>
    <div className="knowledge-network-tools">
      <label>{t('图谱范围', 'Graph scope')}<select aria-label={t('图谱范围', 'Graph scope')} value={scope} onChange={event => onScope(event.target.value as 'current' | 'filtered')}>
        <option value="current">{t('当前知识的一跳关联', 'Current knowledge neighborhood')}</option><option value="filtered">{t('当前筛选的全部知识', 'All filtered knowledge')}</option>
      </select></label>
      <label className="knowledge-network-history"><input type="checkbox" checked={includeHistory} onChange={event => onHistory(event.target.checked)}/>{t('显示历史修订', 'Show revision history')}</label>
    </div>
    {graph.coverage.status === 'unavailable' && <p className="knowledge-network-limitation" role="status">{t('覆盖不完整：显示已知节点与关联，不能据此判断不存在其它关联。', 'Coverage is incomplete. Known nodes and links remain visible; missing links cannot be ruled out.')}</p>}
    <p className="knowledge-network-legend">{t('方框：知识　圆形：实体　虚线框：来源；虚线关联属于历史或待核对判断。', 'Box: knowledge · circle: entity · dashed box: source. Dashed links represent history or judgments needing review.')}</p>
    {!nodes.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('当前筛选没有可浏览的知识。', 'No knowledge in the current filter.')}/>
      : <div className="knowledge-network-canvas" ref={canvasRef} tabIndex={0} aria-label={t('可滚动图谱画布', 'Scrollable graph canvas')}>
        <svg viewBox={`0 0 690 ${height}`} width="690" height={height} role="group" aria-label={t('知识、实体和来源的关联图', 'Relationships among knowledge, entities and sources')}>
          {groups.map((group, index) => group.length ? <text className="knowledge-network-column" x={110 + index * 235} y="23" textAnchor="middle" key={index}>{kindLabel(group[0], lang)}</text> : null)}
          {edges.map(edge => {
            const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) return null;
            const label = edgeLabel(edge, lang); const selected = selectedId === edge.edgeId;
            const pending = 'reviewStatus' in edge && edge.reviewStatus !== 'accepted';
            const path = from.x === to.x ? `M${from.x},${from.y} Q${from.x + 105},${(from.y + to.y) / 2} ${to.x},${to.y}`
              : `M${from.x},${from.y} C${(from.x + to.x) / 2},${from.y} ${(from.x + to.x) / 2},${to.y} ${to.x},${to.y}`;
            return <g key={edge.edgeId} className={`knowledge-network-edge ${edge.edgeKind}${selected ? ' selected' : ''}${!edge.current || pending ? ' provisional' : ''}`} role="button" tabIndex={0}
              aria-label={`${label}：${nodeLabel(nodes.find(node => node.nodeId === edge.from)!, lang)} → ${nodeLabel(nodes.find(node => node.nodeId === edge.to)!, lang)}`}
              aria-pressed={selected} onClick={() => choose(edge.edgeId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(edge.edgeId); } }}>
              <title>{label}{'segmentId' in edge ? ` · ${edge.segmentId}` : ''}{!edge.current ? ` · ${t('历史关联', 'Historical link')}` : ''}</title>
              <path className="knowledge-network-edge-hit" d={path}/><path className="knowledge-network-edge-line" d={path}/>
            </g>;
          })}
          {nodes.map(node => {
            const position = positions.get(node.nodeId)!; const label = nodeLabel(node, lang); const selected = selectedId === node.nodeId;
            const suffix = node.nodeKind === 'knowledge' ? associationLabel(node.association.status, lang)
              : node.nodeKind === 'entity' ? `${node.entityId.slice(-8)} · ${node.current ? t('当前修订', 'Current') : t('绑定旧修订', 'Older binding')}`
                : node.status === 'available' ? t('原文可回查', 'Source readable') : t('来源不可用', 'Source unavailable');
            return <g className={`knowledge-network-node ${node.nodeKind}${selected ? ' selected' : ''}${node.nodeKind !== 'source' && !node.current ? ' historical' : ''}`}
              key={node.nodeId} ref={element => { if (element) nodeRefs.current.set(node.nodeId, element); else nodeRefs.current.delete(node.nodeId); }} transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${kindLabel(node, lang)}：${label} · ${suffix}`} aria-pressed={selected}
              onClick={() => choose(node.nodeId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node.nodeId); } }}>
              <title>{label} · {suffix}</title>
              {node.nodeKind === 'entity' ? <><circle r="27"/><text className="knowledge-network-symbol" textAnchor="middle" y="4">{label.slice(0, 3)}</text></>
                : <><rect x="-96" y="-26" width="192" height="52" rx="6"/><text textAnchor="middle" y="-3">{label.length > 14 ? `${label.slice(0, 14)}…` : label}</text></>}
              <text className="knowledge-network-node-caption" textAnchor="middle" y={node.nodeKind === 'entity' ? 44 : 15}>{node.nodeKind === 'entity' ? `${label.length > 13 ? `${label.slice(0, 13)}…` : label} · ${node.entityId.slice(-4)}` : suffix}</text>
            </g>;
          })}
        </svg>
      </div>}
    <div className="knowledge-network-selectors">
      <label>{t('选择节点', 'Choose a node')}<select aria-label={t('选择图谱节点', 'Choose a graph node')} value={nodes.some(node => node.nodeId === selectedId) ? selectedId : ''} onChange={event => { if (event.target.value) choose(event.target.value); }}>
        <option value="">{t('按名称浏览知识、实体或来源', 'Browse knowledge, entities or sources')}</option>
        {groups.map((group, index) => group.length ? <optgroup key={index} label={kindLabel(group[0], lang)}>{group.map(node => <option key={node.nodeId} value={node.nodeId}>{nodeLabel(node, lang)}{node.nodeKind === 'entity' ? ` · ${node.entityId.slice(-8)} / ${node.entityRevisionId.slice(-8)}` : ''}</option>)}</optgroup> : null)}
      </select></label>
      <label>{t('选择关联', 'Choose a link')}<select aria-label={t('选择图谱关联', 'Choose a graph link')} value={edges.some(edge => edge.edgeId === selectedId) ? selectedId : ''} onChange={event => { if (event.target.value) choose(event.target.value); }}>
        <option value="">{t('查看精确段落、提及与来源', 'Inspect exact segments, mentions and sources')}</option>
        {edges.map(edge => <option value={edge.edgeId} key={edge.edgeId}>{edgeLabel(edge, lang)} · {nodeLabel(nodes.find(node => node.nodeId === edge.from)!, lang)} → {nodeLabel(nodes.find(node => node.nodeId === edge.to)!, lang)}{'segmentId' in edge ? ` · ${edge.segmentId}` : ''}{!edge.current ? ` · ${t('历史', 'Historical')}` : ''}</option>)}
      </select></label>
    </div>
  </section>;
}

function citations(graph: KnowledgeGraph, edge: Edge): Citation[] {
  const source = (id: string) => graph.nodes.find((node): node is SourceNode => node.nodeKind === 'source' && node.nodeId === id);
  if (edge.edgeKind === 'source_evidence') return [{ source: source(edge.to), selection: edge.evidence.selection, basis: edge.evidence.basis, rationale: edge.evidence.interpretation, positionStatus: edge.positionStatus }];
  const entity = graph.nodes.find((node): node is EntityNode => node.nodeKind === 'entity' && node.nodeId === (edge.edgeKind === 'segment_entity' ? edge.to : edge.from));
  const catalogRef = entity ? { analysisId: entity.analysisId, entityRevisionId: entity.entityRevisionId } : undefined;
  if (edge.edgeKind === 'entity_mention') return [{ catalogRef, source: source(edge.to), selection: edge.selection, basis: edge.basis, rationale: edge.rationale, positionStatus: edge.positionStatus, mentionId: edge.mentionId }];
  if (edge.edgeKind === 'segment_entity') return edge.mentions.map(mention => {
    const original = graph.edges.find(value => value.edgeKind === 'entity_mention' && value.from === edge.to && value.mentionId === mention.mentionId);
    return { catalogRef, source: original ? source(original.to) : undefined, selection: mention.selection, basis: mention.basis, rationale: mention.rationale,
      mentionId: mention.mentionId, positionStatus: original && 'positionStatus' in original ? original.positionStatus : undefined };
  });
  if (edge.edgeKind === 'typed_relation') return edge.evidence.map(evidence => ({ source: graph.nodes.find((node): node is SourceNode => node.nodeKind === 'source'
    && node.snapshotId === evidence.source.snapshotId && node.sourceVersion === evidence.source.sourceVersion), selection: evidence.selection, basis: evidence.basis, rationale: evidence.interpretation, relationId: edge.relationId }));
  if (edge.edgeKind === 'component' || edge.edgeKind === 'collection') return graph.edges.filter(value => value.edgeKind === 'entity_mention'
    && (value.from === edge.from || value.from === edge.to) && edge.mentionIds.includes(value.mentionId)).flatMap(value => citations(graph, value));
  return [];
}

/** Exact edge inspection shares the selected canonical reader; it does not manufacture source or identity claims. */
export function KnowledgeGraphInspection({ graph, selectedId, detail, loading, workspace, lang, onLocate, onEntity, onMapping, onKnowledge }: {
  graph: KnowledgeGraph; selectedId?: string; detail?: KnowledgeCandidateDetail; loading: boolean; workspace: string; lang: Language;
  onLocate(selection: KnowledgeReaderSelection): void; onEntity(target: KnowledgeReaderEntityTarget): void;
  onMapping(target?: { analysisId: string; entityRevisionId: string }): void; onKnowledge(ref: { knowledgeId: string; revisionId: string }): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(false); }, [selectedId]);
  const node = graph.nodes.find(value => value.nodeId === selectedId), edge = graph.edges.find(value => value.edgeId === selectedId);
  const owner = knowledgeOwner(graph, node ?? edge, detail?.revision.knowledgeId);
  const entity = node?.nodeKind === 'entity' ? node : edge ? graph.nodes.find((value): value is EntityNode => value.nodeKind === 'entity' && value.nodeId === edge.from)
    ?? graph.nodes.find((value): value is EntityNode => value.nodeKind === 'entity' && value.nodeId === edge.to) : undefined;
  const source = node?.nodeKind === 'source' ? node : undefined;
  const refs = edge ? citations(graph, edge) : source ? graph.edges.filter(value => value.edgeKind === 'source_evidence' && value.to === source.nodeId && value.from === owner?.nodeId).flatMap(value => citations(graph, value)) : [];
  const segmentIds = edge && 'segmentId' in edge ? [edge.segmentId] : edge?.edgeKind === 'typed_relation' ? edge.segmentIds : [];
  if (!node && !edge) return <div className="knowledge-network-inspection"><p>{selectedId ? t('所选关联已变化。请从当前图谱重新选择；已保存正文仍可阅读。', 'The selected link changed. Select it again in the current graph; saved content remains readable.') : t('选择节点或关联，回查它的含义、段落与原文。', 'Select a node or link to inspect its meaning, content and original evidence.')}</p></div>;
  const target = entity ? { analysisId: entity.analysisId, entityRevisionId: entity.entityRevisionId, entityId: entity.entityId } : undefined;
  return <section className="knowledge-network-inspection" aria-label={t('所选图谱依据', 'Selected graph evidence')}>
    <div className="knowledge-network-inspection-heading"><h3>{node ? nodeLabel(node, lang) : edgeLabel(edge!, lang)}</h3><Button size="small" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? t('展开依据', 'Show evidence') : t('收起依据', 'Hide evidence')}</Button>{!collapsed && <Space wrap>
      {target && <Button size="small" onClick={() => onEntity(target)}>{t('核对／纠正此实体', 'Inspect / correct this entity')}</Button>}
      {owner && <Button size="small" disabled={!owner.current || loading || detail?.revision.revisionId !== owner.bodyRef.revisionId} onClick={() => onMapping(entity ? { analysisId: entity.analysisId, entityRevisionId: entity.entityRevisionId } : undefined)}>{t('纠正段落映射', 'Correct segment mappings')}</Button>}
    </Space>}</div>
    {!collapsed && <div className="knowledge-network-inspection-scroll">
      {owner && <p><Button type="link" size="small" onClick={() => { onKnowledge(owner.bodyRef); onLocate({ tab: 'body', segmentId: segmentIds[0] }); }}>{t('打开完整正文：', 'Read complete content: ')}{owner.title}</Button></p>}
      {node?.nodeKind === 'knowledge' && <><p>{associationLabel(node.association.status, lang)} · {node.current ? t('当前正文修订', 'Current content revision') : t('历史正文修订', 'Historical content revision')}</p><p className="candidate-help">{t('保留、关联接受与内容已证实是不同状态。', 'Retention, accepted associations and verified content are separate states.')}</p><code>{node.bodyRef.revisionId}</code></>}
      {node?.nodeKind === 'knowledge' && !!node.associationHistory?.length && <details><summary>{t('关联修订历史', 'Association revision history')}</summary>{node.associationHistory.map(revision => <section className="knowledge-network-citation" key={revision.revisionId}><p>{associationLabel(revision.status, lang)} · {revision.revisionReason}</p><p className="candidate-help">{revision.revisedAt} · {revision.reviewStatus === 'accepted' ? t('已接受关联', 'Associations accepted') : revision.reviewStatus === 'rejected' ? t('已拒绝关联', 'Associations rejected') : t('关联待核对', 'Associations pending review')}</p><p><code>{revision.revisionId}</code></p><p className="candidate-help">{t('绑定正文修订：', 'Bound content revision: ')}<code>{revision.bodyRef.revisionId}</code></p>{revision.issues.map((issue, index) => <p key={index}>{issue}</p>)}</section>)}</details>}
      {entity && <><p>{entity.description}</p>{!!entity.qualifiers.length && <p>{entity.qualifiers.join(' · ')}</p>}<p className="candidate-help">{entity.current ? t('当前实体修订', 'Current entity revision') : t('此处保留原绑定的实体修订', 'The originally bound entity revision is shown')} · {entity.identityStatus === 'unresolved' ? t('身份有歧义', 'Identity unresolved') : t('提出对应，待核对', 'Proposed identity, needs review')}</p>
        {entity.uncertainties.map((value, index) => <p key={index}>{value}</p>)}<details><summary>{t('精确实体身份', 'Exact entity identity')}</summary><code>{entity.analysisId} / {entity.entityRevisionId} / {entity.entityId}</code></details></>}
      {source && <><p>{source.origin ? <Link href={workspaceHref(conversationPath(source.origin.threadId, source.origin.turnId), workspace)}>{source.origin.title || t('打开原始对话', 'Open original conversation')}</Link> : t('所选来源窗口', 'Selected source window')}</p>{source.limitations.map((value, index) => <p key={index}>{value}</p>)}<p className="candidate-help">{source.status === 'unavailable' ? t('来源不可用，保存的引文仍可读。', 'Source unavailable; saved quotations remain readable.') : t('以下依据属于当前打开的精确知识修订。', 'The evidence below belongs to the exact knowledge revision currently open.')}</p><details><summary>{t('精确来源身份', 'Exact source identity')}</summary><code>{source.snapshotId} / {source.sourceVersion}</code></details></>}
      {edge && <><p className="candidate-help">{edgeStateLabel(edge, lang)}{'reviewStatus' in edge && ` · ${edge.reviewStatus === 'accepted' ? t('关联已接受', 'Associations accepted') : edge.reviewStatus === 'rejected' ? t('关联已拒绝', 'Associations rejected') : t('关联待核对', 'Associations pending review')}`}</p>
        <p>{nodeLabel(graph.nodes.find(node => node.nodeId === edge.from)!, lang)} → {nodeLabel(graph.nodes.find(node => node.nodeId === edge.to)!, lang)}</p>
        {'catalogCurrent' in edge && !edge.catalogCurrent && <p className="candidate-help">{t('绑定的实体目录已有新修订；此处仍保留原精确绑定，需明确核对与应用。', 'The bound entity catalog has a newer revision. The exact original binding is retained until explicitly reviewed and applied.')}</p>}
        {edge.edgeKind === 'typed_relation' && <p>{edge.modality} / {edge.polarity} · {t('已有明确派生关系', 'Explicit derived relation')}</p>}
        {(edge.edgeKind === 'component' || edge.edgeKind === 'collection') && <><p>{edge.rationale}</p>{edge.edgeKind === 'collection' && <p className="candidate-help">{edge.completeness === 'complete' ? t('来源声明成员完整', 'Source declares complete membership') : edge.completeness === 'partial' ? t('仅部分成员已知', 'Only partial membership is known') : t('成员完整性未知', 'Membership completeness is unknown')} · {t('集合知识不会自动归属每个成员。', 'Collection knowledge is not automatically attributed to every member.')}</p>}</>}
        {edge.edgeKind === 'possible_identity' && <p className="candidate-help">{t('这只是可能对应的候选，不确认二者为同一对象。', 'This is only a possible identity candidate; it does not confirm that the two are the same entity.')}</p>}
        {segmentIds.map(id => <div key={id} className="knowledge-network-segment"><p>{owner?.segments.find(segment => segment.segmentId === id)?.text ?? id}</p><Button type="link" size="small" onClick={() => onLocate({ tab: 'body', segmentId: id, relationId: edge.edgeKind === 'typed_relation' ? edge.relationId : undefined })}>{t('在正文中定位', 'Locate in content')}</Button></div>)}
      </>}
        {refs.map((ref, index) => {
          const loaded = detail?.sources.find(entry => entry.status === 'available' && entry.window.snapshotId === ref.source?.snapshotId && entry.window.sourceVersion === ref.source?.sourceVersion);
          const excerpt = loaded?.status === 'available' ? loaded.window.excerpts.find(value => value.evidenceRef === ref.selection.evidenceRef) : undefined;
          const matched = excerpt?.text.slice(ref.selection.start, ref.selection.end) === ref.selection.quote;
          return <section className="knowledge-network-citation" key={`${ref.mentionId ?? ref.selection.evidenceRef}:${index}`}>
            <blockquote>{ref.selection.quote}</blockquote><p className="candidate-help">{ref.basis === 'inference' ? t('推断', 'Inference') : ref.basis === 'direct_observation' ? t('直接观测', 'Direct observation') : ref.basis === 'explicit' ? t('明确提及', 'Explicit mention') : ref.basis === 'inferred' ? t('推断对应', 'Inferred identity') : t('来源中的说法', 'Source assertion')}{ref.rationale ? ` · ${ref.rationale}` : ''}</p>
            <p className="candidate-help">{ref.source?.origin?.title || t('精确来源窗口', 'Exact source window')} · {ref.selection.evidenceRef} · {ref.selection.start}–{ref.selection.end}</p>
            {ref.source && <Button type="link" size="small" onClick={() => onLocate({ tab: 'evidence', segmentId: segmentIds[0], mentionId: ref.mentionId, relationId: ref.relationId, ...(ref.catalogRef ? { catalogRef: ref.catalogRef } : {}), evidence: { snapshotId: ref.source!.snapshotId, sourceVersion: ref.source!.sourceVersion, evidenceRef: ref.selection.evidenceRef, start: ref.selection.start, end: ref.selection.end } })}>{t('在阅读器回查依据', 'Inspect evidence in reader')}</Button>}
            {excerpt ? <details><summary>{t('展开这处依据的完整原文', 'Show this evidence in the full source message')}</summary><p className="candidate-help">{t('来源消息', 'Source message')} {excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.timestamp ?? t('来源时间未知', 'Source time unknown')}</p>
              {!matched && <Alert type="warning" title={t('引文位置不匹配，不能作为已核对原文。', 'Quotation position does not match; it is not verified source evidence.')}/>}<pre className="knowledge-source">{matched ? <>{excerpt.text.slice(0, ref.selection.start)}<mark>{ref.selection.quote}</mark>{excerpt.text.slice(ref.selection.end)}</> : excerpt.text}</pre></details>
              : <p className="candidate-help">{loading ? t('正在读取所选知识的来源。', 'Loading the selected knowledge source.') : ref.source?.status === 'unavailable' ? t('原文不可用，不能完整核对。', 'Source unavailable; full review is not possible.') : t('此来源原文尚未载入当前正文；可先打开对应的精确知识修订。', 'This source is not loaded with the current content. Open its exact knowledge revision first.')}</p>}
          </section>;
        })}
      {edge && <details><summary>{t('精确关联身份', 'Exact link identity')}</summary><code>{edge.edgeId}</code>{'projectionRevisionId' in edge && <p><code>{edge.projectionRevisionId}</code></p>}</details>}
      {!!graph.coverage.gaps.length && <details><summary>{t('工作区覆盖限制', 'Workspace coverage limits')}</summary>{graph.coverage.gaps.map((gap, index) => <p key={index}>{gapLabel(gap, lang)}</p>)}</details>}
    </div>}
  </section>;
}
