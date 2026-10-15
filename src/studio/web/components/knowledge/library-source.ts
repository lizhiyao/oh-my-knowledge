import { useEffect, useState } from 'react';
import type { KnowledgeEntityLibraryDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { requestLibraryEntity } from './library-request';

export type LibrarySeed = { analysisId: string; entityId: string; revision?: string };
type SourceSelection =
  | { phase: 'idle' }
  | { phase: 'loading' | 'failed'; request: LibrarySeed }
  | { phase: 'ready'; request: LibrarySeed; detail: KnowledgeEntityLibraryDetail; mentionIds: string[]; rationale: string };

/** The selected source owns its read and review fields; it never edits the organization draft. */
export function useLibrarySource(workspace: string, seed?: LibrarySeed) {
  const [state, setState] = useState<SourceSelection>(() => seed ? { phase: 'loading', request: { ...seed } } : { phase: 'idle' });
  const request = state.phase === 'idle' ? undefined : state.request;
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setState({ phase: 'loading', request });
    void requestLibraryEntity<KnowledgeEntityLibraryDetail>(workspace, 'entity-detail', request, controller.signal)
      .then(detail => {
        const mentionIds = detail.revision.mentions.filter(mention => mention.entityId === detail.entity.entityId).map(mention => mention.mentionId);
        if (!controller.signal.aborted) setState(current => current.phase !== 'idle' && current.request === request
          ? { phase: 'ready', request, detail, mentionIds, rationale: '' } : current);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState(current => current.phase !== 'idle' && current.request === request
          ? { phase: 'failed', request } : current);
      });
    return () => controller.abort();
  }, [workspace, request]);
  return {
    state,
    select(target: LibrarySeed) { setState({ phase: 'loading', request: { ...target } }); },
    clear() { setState({ phase: 'idle' }); },
    retry() { if (request) setState({ phase: 'loading', request: { ...request } }); },
    setMentionIds(mentionIds: string[]) { setState(current => current.phase === 'ready' ? { ...current, mentionIds } : current); },
    setRationale(rationale: string) { setState(current => current.phase === 'ready' ? { ...current, rationale } : current); },
  };
}
