import type { Metadata } from 'next';
import { z } from 'zod';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { KnowledgeLibrary } from '../../../components/knowledge/library';
import { EvidenceSelectionSchema, KnowledgeBodyEvidenceSchema } from '../../../../../knowledge/contracts';
const readerEvidenceSchema = KnowledgeBodyEvidenceSchema.shape.source.extend(
  EvidenceSelectionSchema.omit({ quote: true }).shape,
).refine(value => value.end > value.start);
const readerCatalogSchema = z.strictObject({ analysisId: z.string().uuid(), entityRevisionId: z.string().uuid() });
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return pageTitle('library', await requestStudioLang()); }
export default async function Page({ searchParams }: { searchParams: Promise<{ workspace?: string; knowledge?: string; object?: string; revision?: string; analysis?: string; entity?: string; entityRevision?: string;
  view?: string; selection?: string; scope?: string; section?: string; segment?: string; mention?: string; relation?: string; relationRevision?: string; catalog?: string; evidence?: string;
  history?: string; query?: string; choice?: string; kind?: string; objects?: string }> }) {
  const params = await searchParams; const lang = await requestStudioLang();
  let evidence: ReturnType<typeof readerEvidenceSchema.parse> | undefined;
  let invalidEvidence = false;
  let catalogRef: z.infer<typeof readerCatalogSchema> | undefined;
  if (params.catalog !== undefined) {
    try { const parsed = readerCatalogSchema.safeParse(JSON.parse(params.catalog)); if (parsed.success) catalogRef = parsed.data; else invalidEvidence = true; } catch { invalidEvidence = true; }
  }
  if (params.evidence !== undefined) {
    try {
      const parsed = readerEvidenceSchema.safeParse(JSON.parse(params.evidence));
      if (parsed.success) evidence = parsed.data; else invalidEvidence = true;
    } catch { invalidEvidence = true; }
  }
  return <StudioShell lang={lang} active="knowledge"><KnowledgeLibrary key={params.workspace ?? ''} lang={lang} initialWorkspace={params.workspace}
    knowledgeId={params.knowledge} objectId={params.object} revisionId={params.revision}
    initialView={params.view === 'graph' ? 'graph' : params.view === 'task' ? 'task' : 'list'} initialGraphSelection={params.selection}
    initialGraphScope={params.scope === 'filtered' ? 'filtered' : 'current'}
    initialGraphHistory={params.history === 'true'}
    initialGraphEntity={params.view === 'graph' && params.analysis && params.entity && params.entityRevision ? {
      analysisId: params.analysis, entityId: params.entity, entityRevisionId: params.entityRevision } : undefined}
    initialQuery={params.query}
    initialChoice={params.choice === 'pending' || params.choice === 'retain' || params.choice === 'discard' ? params.choice : 'all'}
    initialKind={params.kind === 'fact' || params.kind === 'case' || params.kind === 'method' ? params.kind : 'all'}
    initialObjects={params.objects?.split(',').filter(Boolean)}
    initialReaderTab={invalidEvidence ? 'body' : params.section === 'body' || params.section === 'evidence' || params.section === 'associations' || params.section === 'related' || params.section === 'history' ? params.section : undefined}
    initialSegmentId={invalidEvidence ? undefined : params.segment} initialMentionId={invalidEvidence ? undefined : params.mention}
    initialRelationId={invalidEvidence ? undefined : params.relation} initialCatalogRef={invalidEvidence ? undefined : catalogRef}
    initialRelationRevisionId={!invalidEvidence && params.section === 'related' && z.string().uuid().safeParse(params.relationRevision).success ? params.relationRevision : undefined}
    initialEvidence={evidence} initialReaderSelectionInvalid={invalidEvidence}
    initialKnowledgeRevision={!params.object ? params.revision : undefined} seed={params.view !== 'graph' && params.analysis && params.entity ? {
      analysisId: params.analysis, entityId: params.entity, revision: params.entityRevision } : undefined}/></StudioShell>;
}
