import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssociationGenerationResponseSchema } from '../../src/knowledge/extraction/body-generation-wire.js';
import { associationMentionKey, compileAssociationCatalog } from '../../src/knowledge/extraction/association-catalog.js';
import type { EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';

const window: EvidenceWindow = { snapshotId: randomUUID(), sourceVersion: `sha256:${'1'.repeat(64)}`, sourcePath: '/authored-only', sourceKind: 'codex',
  projectionVersion: 'knowledge-window-v2', capturedAt: '2026-10-30T00:00:00Z', startRecord: 0, endRecord: 0,
  excerpts: [{ evidenceRef: 'r0', recordIndex: 0, eventKind: 'message', role: 'user', text: 'SDK 0.165.0，CLI 0.165.0' }], records: [], limitations: [] };
const mention = (quote: string, before: string | null = null) => ({ mentionKey: 'own', selection: {
  evidenceRef: 'r0', quote, contextBefore: before, contextAfter: null }, basis: 'explicit', rationale: 'Literal authored source mention.' });
const entity = (entityId: string, label: string, referentKind: string, mentions: unknown[], overrides: Record<string, unknown> = {}) => ({
  entityId, label, description: `The authored source ${label}.`, qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
  referentKind, componentLink: null, collectionLink: null, mentions, ...overrides,
});
const catalog = (entities: unknown[]) => AssociationGenerationResponseSchema.parse({ responseKind: 'knowledge-association-generation', schemaVersion: 3,
  catalogs: [{ sourceKey: 's0', entities }], associations: [] }).catalogs[0];

describe('owned association catalog compilation', () => {
  it('compiles same local mention keys under separate entities and locates each repeated version in its exact context', () => {
    const declared = catalog([
      entity('sdk', 'SDK', 'component', [mention('SDK')]),
      entity('sdk-version', 'SDK 0.165.0', 'version', [mention('0.165.0', 'SDK ')],
        { componentLink: { entityId: 'sdk', mentionKeys: ['own'], rationale: 'Its own source version mention names the SDK context.' } }),
      entity('cli', 'CLI', 'component', [mention('CLI')]),
      entity('cli-version', 'CLI 0.165.0', 'version', [mention('0.165.0', 'CLI ')],
        { componentLink: { entityId: 'cli', mentionKeys: ['own'], rationale: 'Its own source version mention names the CLI context.' } }),
    ]);
    const result = compileAssociationCatalog(declared, window, randomUUID);
    expect(result.draft.entities).toHaveLength(4); expect(result.draft.mentions).toHaveLength(4);
    expect(new Set(result.draft.mentions.map(value => value.mentionId)).size).toBe(4);
    for (const local of ['sdk-version', 'cli-version']) {
      const compiled = result.draft.entities.find(value => value.entityId === result.entityIds.get(local))!;
      const ownId = result.mentionIds.get(associationMentionKey(local, 'own'))!;
      expect(compiled.componentRef?.mentionIds).toEqual([ownId]);
      expect(result.draft.mentions.find(value => value.mentionId === ownId)?.entityId).toBe(compiled.entityId);
    }
    expect(result.draft.mentions.filter(value => value.selection.quote === '0.165.0').map(value => value.selection.start)).toEqual([4, 16]);
    expect(result.draft.entities.every(value => value.identityStatus === 'proposed')).toBe(true);
  });

  it.each(['object-parent', 'object-child', 'foreign-mention'] as const)('rejects %s rather than repairing a component declaration', failure => {
    const target = entity('sdk', 'SDK', failure === 'object-parent' ? 'object' : 'component', [mention('SDK')]);
    const childMention = { ...mention('0.165.0', 'SDK '), mentionKey: 'version' };
    const child = entity('version', 'SDK 0.165.0', failure === 'object-child' ? 'object' : 'version', [childMention], {
      componentLink: { entityId: 'sdk', mentionKeys: [failure === 'foreign-mention' ? 'own' : 'version'], rationale: 'Authored invalid closure.' },
    });
    const declared = catalog([target, child]), original = structuredClone(declared);
    expect(() => compileAssociationCatalog(declared, window, randomUUID)).toThrow(failure === 'foreign-mention'
      ? 'Identity evidence must belong' : failure === 'object-child' ? 'unexpected_component_reference' : 'invalid_component_target');
    expect(declared).toEqual(original);
  });

  it.each(['entity', 'mention', 'both'] as const)('compiles maximum-length %s keys before validating persistent component and collection references', boundary => {
    const ownerId = boundary === 'mention' ? 'version' : 'v'.repeat(256);
    const mentionKey = boundary === 'entity' ? 'own' : '\\"'.repeat(128);
    const ownMention = { ...mention('0.165.0', 'SDK '), mentionKey };
    for (const referentKind of ['version', 'collection']) {
      const declared = catalog([
        entity('sdk', 'SDK', 'component', [mention('SDK')]),
        entity(ownerId, 'SDK 0.165.0', referentKind, [ownMention], referentKind === 'version'
          ? { componentLink: { entityId: 'sdk', mentionKeys: [mentionKey], rationale: 'Its own version mention.' } }
          : { collectionLink: { memberEntityIds: ['sdk'], completeness: 'complete', mentionKeys: [mentionKey], rationale: 'Its own collection mention.' } }),
      ]);
      const result = compileAssociationCatalog(declared, window, randomUUID);
      const compiled = result.draft.entities.find(value => value.entityId === result.entityIds.get(ownerId))!;
      expect((compiled.componentRef ?? compiled.collection)?.mentionIds).toEqual([result.mentionIds.get(associationMentionKey(ownerId, mentionKey))]);
      expect(result.draft.mentions.find(value => value.entityId === compiled.entityId)?.selection.quote).toBe('0.165.0');
    }
  });

  it('rejects missing context for a repeated quote and duplicate physical mention positions', () => {
    expect(() => compileAssociationCatalog(catalog([entity('sdk', 'Version', 'object', [mention('0.165.0')])]), window, randomUUID)).toThrow('ambiguous_quote');
    expect(() => compileAssociationCatalog(catalog([entity('one', 'SDK', 'object', [mention('SDK')]),
      entity('two', 'Same source SDK', 'object', [mention('SDK')])]), window, randomUUID)).toThrow('duplicate_mention_position');
  });

  it('rejects duplicate owned keys and missing mentions without deleting unsupported entities', () => {
    expect(() => compileAssociationCatalog(catalog([entity('sdk', 'SDK', 'object', [mention('SDK'), mention('CLI')])]), window, randomUUID)).toThrow('Duplicate owned mention key');
    expect(() => compileAssociationCatalog(catalog([entity('sdk', 'SDK', 'object', [])]), window, randomUUID)).toThrow('entity_without_mention');
  });
});
