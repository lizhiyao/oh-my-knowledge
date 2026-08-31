import type { CoreRunArtifactStore } from '../artifact-store/index.js';
import type { CoreStudioCatalog } from './contracts.js';
import {
  projectCoreStudioRunCard,
  projectCoreStudioRunDetail,
} from './projection.js';

export function createCoreStudioCatalog(
  store: CoreRunArtifactStore,
): CoreStudioCatalog {
  async function list() {
    return (await store.list()).map(projectCoreStudioRunCard);
  }

  async function get(runId: string) {
    const source = await store.get(runId);
    return source === undefined ? undefined : projectCoreStudioRunDetail(source);
  }

  async function inspect(runId: string) {
    const card = await store.inspect(runId);
    return card === undefined ? undefined : projectCoreStudioRunCard(card);
  }

  return Object.freeze({ list, get, inspect });
}
