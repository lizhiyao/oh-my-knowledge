export type AuthoredArtifactKind = 'skill' | 'prompt';
export interface CarrierKnowledgeRef { knowledgeId: string; revisionId: string; generation: number }
export type CarrierSource = { sourceKind: 'new' } | { sourceKind: 'library'; artifactId: string } | { sourceKind: 'local'; path: string };
export interface CarrierVersion {
  schemaVersion: 'omk-carrier-v1'; artifactId: string; revisionId: string; version: number;
  name: string; directoryName: string; artifactKind: AuthoredArtifactKind; savedAt: string;
  knowledgeRefs: CarrierKnowledgeRef[]; contentHash: string;
  baseline: { locator: string; contentHash: string; revisionId: string | null } | null;
}
export interface CarrierDetail extends CarrierVersion { content: string; locator: string; artifactPath: string; drifted: boolean; versions: { version: number; revisionId: string; savedAt: string }[] }
export type CarrierRow = Pick<CarrierDetail, 'artifactId' | 'name' | 'artifactKind' | 'version' | 'savedAt' | 'locator' | 'drifted'>;
export interface CarrierDraft {
  artifactId: string; artifactKind: AuthoredArtifactKind; name: string; directoryName: string;
  source: CarrierSource; baselineRevisionId: string | null; baselineHash: string | null; baseContent: string; content: string; knowledgeRefs: CarrierKnowledgeRef[]; selectedRefs: CarrierKnowledgeRef[];
}
