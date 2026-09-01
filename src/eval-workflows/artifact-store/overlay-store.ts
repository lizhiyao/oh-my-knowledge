import type {
  CoreRunArtifactIndexCard,
  CoreRunArtifactStore,
  SaveCoreRunArtifactsRequest,
  StoredCoreRunArtifacts,
} from './contracts.js';

export type CoreRunArtifactOverlayErrorCode =
  | 'CORE_RUN_ARTIFACT_OVERLAY_ID_CONFLICT'
  | 'CORE_RUN_ARTIFACT_OVERLAY_SHADOW_CONFLICT';

export class CoreRunArtifactOverlayError extends TypeError {
  readonly code: CoreRunArtifactOverlayErrorCode;
  readonly runId: string;

  constructor(input: {
    code: CoreRunArtifactOverlayErrorCode;
    runId: string;
    message: string;
  }) {
    super(input.message);
    this.name = 'CoreRunArtifactOverlayError';
    this.code = input.code;
    this.runId = input.runId;
  }
}

interface LocatedCard {
  readonly store: CoreRunArtifactStore;
  readonly card: CoreRunArtifactIndexCard;
}

function assertNoConflict(runId: string, located: readonly LocatedCard[]): void {
  const digests = new Set(located.map(({ card }) => card.artifactSetDigest));
  if (digests.size > 1) {
    throw new CoreRunArtifactOverlayError({
      code: 'CORE_RUN_ARTIFACT_OVERLAY_ID_CONFLICT',
      runId,
      message: 'Core run id resolves to different artifact sets across store layers.',
    });
  }
}

export function createOverlayCoreRunArtifactStore(
  primary: CoreRunArtifactStore,
  fallbacks: readonly CoreRunArtifactStore[],
): CoreRunArtifactStore {
  const stores = Object.freeze([primary, ...fallbacks]);

  async function locatedCards(runId?: string): Promise<LocatedCard[]> {
    if (runId !== undefined) {
      const located = await Promise.all(stores.map(async (store) => ({
        store,
        card: await store.inspect(runId),
      })));
      return located.filter((entry): entry is LocatedCard => entry.card !== undefined);
    }
    const cardsByStore = await Promise.all(stores.map(async (store) => ({
      store,
      cards: await store.list(),
    })));
    return cardsByStore.flatMap(({ store, cards }) => cards
      .filter((card) => runId === undefined || card.runId === runId)
      .map((card) => ({ store, card })));
  }

  async function get(runId: string): Promise<StoredCoreRunArtifacts | undefined> {
    const located = await locatedCards(runId);
    if (located.length === 0) return undefined;
    assertNoConflict(runId, located);
    return located[0].store.get(runId);
  }

  async function list(): Promise<CoreRunArtifactIndexCard[]> {
    const located = await locatedCards();
    const byRunId = new Map<string, LocatedCard[]>();
    for (const entry of located) {
      const current = byRunId.get(entry.card.runId) ?? [];
      current.push(entry);
      byRunId.set(entry.card.runId, current);
    }
    const cards: CoreRunArtifactIndexCard[] = [];
    for (const [runId, entries] of byRunId) {
      assertNoConflict(runId, entries);
      cards.push(entries[0].card);
    }
    return cards.sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
      || left.runId.localeCompare(right.runId)
    ));
  }

  async function inspect(runId: string): Promise<CoreRunArtifactIndexCard | undefined> {
    const located = await locatedCards(runId);
    if (located.length === 0) return undefined;
    assertNoConflict(runId, located);
    return located[0].card;
  }

  async function exists(runId: string): Promise<boolean> {
    const located = await locatedCards(runId);
    if (located.length === 0) return false;
    assertNoConflict(runId, located);
    return true;
  }

  async function save(
    request: Readonly<SaveCoreRunArtifactsRequest>,
  ): Promise<StoredCoreRunArtifacts> {
    const fallbackEntries = (await Promise.all(fallbacks.map(async (store) => ({
      store,
      card: await store.inspect(request.runId),
    })))).filter((entry) => entry.card !== undefined);
    if (fallbackEntries.length > 0) {
      throw new CoreRunArtifactOverlayError({
        code: 'CORE_RUN_ARTIFACT_OVERLAY_SHADOW_CONFLICT',
        runId: request.runId,
        message: 'Core run id already exists in a read-only fallback store layer.',
      });
    }
    const stored = await primary.save(request);
    const concurrentFallback = (await locatedCards(request.runId)).filter(
      ({ store }) => store !== primary,
    );
    if (concurrentFallback.length > 0) {
      const primaryCard = await primary.inspect(request.runId);
      if (primaryCard === undefined) {
        throw new CoreRunArtifactOverlayError({
          code: 'CORE_RUN_ARTIFACT_OVERLAY_SHADOW_CONFLICT',
          runId: request.runId,
          message: 'Published primary run index is unavailable during overlay verification.',
        });
      }
      assertNoConflict(request.runId, [
        { store: primary, card: primaryCard },
        ...concurrentFallback,
      ]);
      throw new CoreRunArtifactOverlayError({
        code: 'CORE_RUN_ARTIFACT_OVERLAY_SHADOW_CONFLICT',
        runId: request.runId,
        message: 'Core run id was concurrently published in a fallback store layer.',
      });
    }
    return stored;
  }

  return Object.freeze({ save, get, inspect, list, exists });
}
