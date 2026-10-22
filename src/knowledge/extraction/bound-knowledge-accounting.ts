import { z } from 'zod';
import type { EvidenceExcerpt, EvidenceSelection } from '../contracts.js';
import type { ExtractionProposal } from './proposals.js';
import { locateQuoteOccurrence, QuoteOccurrenceLocatorSchema } from './quote-occurrence.js';

const id = z.string().min(1).max(256);
const text = z.string().min(1).max(4096).refine(value => value.trim().length > 0);
const anchor = QuoteOccurrenceLocatorSchema.extend({
  occurrence: QuoteOccurrenceLocatorSchema.shape.occurrence.unwrap().nullable(),
});
export const BoundKnowledgeCatalogGapSchema = z.strictObject({
  gapId: id,
  gapKind: z.enum(['catalog_blocker', 'identity_unknown', 'granularity_unknown', 'scope_excluded', 'context_only']),
  reason: text, anchors: z.array(anchor).min(1).max(64),
});
export const BoundKnowledgeMaterialAccountingSchema = z.strictObject({
  materialId: id, meaning: text, anchors: z.array(anchor).min(1).max(64),
  dispositionKind: z.enum(['expressed', 'not_expressed', 'context_only', 'scope_excluded', 'undetermined']),
  statementRefs: z.array(z.strictObject({ proposalId: id, statementId: id })).max(512),
  reason: text.nullable(), catalogGapIds: z.array(id).max(64),
});
export const BoundKnowledgeExcerptAccountingSchema = z.strictObject({
  evidenceRef: z.string().min(1), materialIds: z.array(id).max(1024), noMaterialReason: text.nullable(),
});
export type BoundKnowledgeCatalogGap = z.infer<typeof BoundKnowledgeCatalogGapSchema>;
export type BoundKnowledgeMaterialAccounting = z.infer<typeof BoundKnowledgeMaterialAccountingSchema>;
export type BoundKnowledgeExcerptAccounting = z.infer<typeof BoundKnowledgeExcerptAccountingSchema>;
export interface BoundKnowledgeAccounting {
  status: 'closed' | 'has_issues'; issues: string[];
  groundedMaterialAnchors: { materialId: string; anchorIndex: number; selection: EvidenceSelection }[];
  unexpressedMaterialIds: string[]; unresolvedMaterialIds: string[]; unresolvedCatalogGapIds: string[];
}
export interface BoundKnowledgeAccountingInput {
  catalogGaps: readonly unknown[]; materialAccounting: readonly unknown[]; excerptAccounting: readonly unknown[];
}

/** Positional accounting of model declarations only. No semantic completeness, gap qualification or source filtering. */
export function checkBoundKnowledgeAccounting(input: BoundKnowledgeAccountingInput,
  accepted: readonly ExtractionProposal[], excerpts: readonly EvidenceExcerpt[]) {
  const issues: string[] = [], unresolved = new Set<string>();
  const issue = (value: string, materialId?: string) => {
    issues.push(value); if (materialId !== undefined) unresolved.add(materialId);
  };
  const rows = <T>(values: readonly unknown[], schema: z.ZodType<T>, field: string) => values.flatMap((value, index) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) issue(`${field}:${index}:invalid_structure:${problem.path.join('.')}`);
      return [];
    }
    return [{ index, value: parsed.data }];
  });
  const gaps = rows(input.catalogGaps, BoundKnowledgeCatalogGapSchema, 'catalogGaps');
  const materials = rows(input.materialAccounting, BoundKnowledgeMaterialAccountingSchema, 'materialAccounting');
  const sources = rows(input.excerptAccounting, BoundKnowledgeExcerptAccountingSchema, 'excerptAccounting');
  const counts = (values: readonly string[]) => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const gapCounts = counts(gaps.map(row => row.value.gapId));
  const materialCounts = counts(materials.map(row => row.value.materialId));
  const sourceCounts = counts(sources.map(row => row.value.evidenceRef));
  const excerptById = new Map<string, EvidenceExcerpt[]>();
  for (const excerpt of excerpts) excerptById.set(excerpt.evidenceRef, [...(excerptById.get(excerpt.evidenceRef) ?? []), excerpt]);
  const sourceIds = new Set(excerptById.keys());
  const locate = (value: z.infer<typeof anchor>) => locateQuoteOccurrence({ evidenceRef: value.evidenceRef, quote: value.quote,
    ...(value.occurrence === null ? {} : { occurrence: value.occurrence }) }, excerptById.get(value.evidenceRef) ?? []);
  const groundedGapAnchors: { gapId: string; anchorIndex: number; selection: EvidenceSelection }[] = [];
  for (const { index, value: gap } of gaps) {
    if (gapCounts.get(gap.gapId) !== 1) issue(`catalogGaps:${index}:duplicate_gap`);
    for (const [anchorIndex, value] of gap.anchors.entries()) {
      const selection = locate(value);
      if (typeof selection === 'string') issue(`catalogGaps:${index}:anchor:${anchorIndex}:${selection}`);
      else groundedGapAnchors.push({ gapId: gap.gapId, anchorIndex, selection });
    }
  }
  const groundedMaterialAnchors: BoundKnowledgeAccounting['groundedMaterialAnchors'] = [];
  const groundedSourcesByMaterial = new Map<string, Set<string>>();
  const referencedStatements = new Set<string>();
  const statementKey = (proposalId: string, statementId: string) => JSON.stringify([proposalId, statementId]);
  const proposalById = new Map(accepted.map(proposal => [proposal.proposalId, proposal]));
  for (const { index, value: material } of materials) {
    const prefix = `materialAccounting:${index}`, materialId = material.materialId;
    const problem = (value: string) => issue(`${prefix}:${value}`, materialId);
    if (materialCounts.get(materialId) !== 1) problem('duplicate_material');
    const located: EvidenceSelection[] = [];
    for (const [anchorIndex, value] of material.anchors.entries()) {
      const selection = locate(value);
      if (typeof selection === 'string') problem(`anchor:${anchorIndex}:${selection}`);
      else {
        located.push(selection); groundedMaterialAnchors.push({ materialId, anchorIndex, selection });
        if (!groundedSourcesByMaterial.has(materialId)) groundedSourcesByMaterial.set(materialId, new Set());
        groundedSourcesByMaterial.get(materialId)!.add(selection.evidenceRef);
      }
    }
    if (new Set(material.catalogGapIds).size !== material.catalogGapIds.length) problem('duplicate_catalog_gap_reference');
    for (const gapId of material.catalogGapIds) if (gapCounts.get(gapId) !== 1) problem('unknown_or_ambiguous_catalog_gap');
    const expressed = material.dispositionKind === 'expressed';
    if (expressed ? material.reason !== null || material.statementRefs.length === 0
      : material.reason === null || material.statementRefs.length !== 0) problem('invalid_disposition_fields');
    if (['not_expressed', 'undetermined'].includes(material.dispositionKind)) unresolved.add(materialId);
    const seenRefs = new Set<string>(), supported = new Set<EvidenceSelection>();
    for (const [refIndex, ref] of material.statementRefs.entries()) {
      const key = statementKey(ref.proposalId, ref.statementId);
      if (seenRefs.has(key)) problem(`statementRef:${refIndex}:duplicate_reference`);
      seenRefs.add(key);
      const proposal = proposalById.get(ref.proposalId);
      if (!proposal?.draft.content.statements.some(statement => statement.statementId === ref.statementId)) {
        problem(`statementRef:${refIndex}:unknown_accepted_statement`); continue;
      }
      const evidenceIds = new Set(proposal.draft.evidence.filter(link => link.statementIds.includes(ref.statementId))
        .map(link => link.evidenceLinkId));
      const citations = proposal.citations.filter(citation => evidenceIds.has(citation.evidenceLinkId));
      const covered = located.filter(selection => citations.some(citation => citation.selection.evidenceRef === selection.evidenceRef
        && citation.selection.start <= selection.start && citation.selection.end >= selection.end));
      if (covered.length === 0) problem(`statementRef:${refIndex}:no_containing_citation`);
      else if (expressed) { referencedStatements.add(key); covered.forEach(selection => supported.add(selection)); }
    }
    if (expressed && located.some(selection => !supported.has(selection))) problem('uncovered_material_anchor');
  }
  const materialById = new Map(materials.map(row => [row.value.materialId, row.value]));
  const sourceMaterials = new Map<string, Set<string>>();
  for (const { index, value: row } of sources) {
    const prefix = `excerptAccounting:${index}`;
    if (!sourceIds.has(row.evidenceRef)) issue(`${prefix}:unknown_evidence`);
    if (sourceCounts.get(row.evidenceRef) !== 1) issue(`${prefix}:duplicate_excerpt`);
    if (new Set(row.materialIds).size !== row.materialIds.length) issue(`${prefix}:duplicate_material_reference`);
    if (row.materialIds.length ? row.noMaterialReason !== null : row.noMaterialReason === null) issue(`${prefix}:invalid_reason`);
    if (!sourceMaterials.has(row.evidenceRef)) sourceMaterials.set(row.evidenceRef, new Set());
    for (const materialId of row.materialIds) {
      sourceMaterials.get(row.evidenceRef)!.add(materialId);
      if (!materialById.has(materialId) || materialCounts.get(materialId) !== 1) issue(`${prefix}:unknown_or_ambiguous_material`);
      else if (!groundedSourcesByMaterial.get(materialId)?.has(row.evidenceRef)) {
        issue(`${prefix}:material_without_source_anchor`, materialId);
      }
    }
  }
  for (const evidenceRef of sourceIds) if (!sourceCounts.has(evidenceRef)) issue('excerptAccounting:missing_excerpt');
  for (const { value: material } of materials) for (const evidenceRef of new Set(material.anchors.map(anchor => anchor.evidenceRef))) {
    if (!sourceMaterials.get(evidenceRef)?.has(material.materialId)) {
      issue('excerptAccounting:missing_material_source', material.materialId);
    }
  }
  for (const proposal of accepted) for (const statement of proposal.draft.content.statements) {
    if (!referencedStatements.has(statementKey(proposal.proposalId, statement.statementId))) issue('materialAccounting:unaccounted_accepted_statement');
  }
  return {
    groundedGapAnchors,
    accounting: {
      status: issues.length ? 'has_issues' as const : 'closed' as const, issues: [...new Set(issues)], groundedMaterialAnchors,
      unexpressedMaterialIds: [...new Set(materials.filter(row => row.value.dispositionKind !== 'expressed').map(row => row.value.materialId))],
      unresolvedMaterialIds: [...unresolved],
      unresolvedCatalogGapIds: [...new Set(gaps.filter(row => ['catalog_blocker', 'identity_unknown', 'granularity_unknown'].includes(row.value.gapKind))
        .map(row => row.value.gapId))],
    } satisfies BoundKnowledgeAccounting,
  };
}
