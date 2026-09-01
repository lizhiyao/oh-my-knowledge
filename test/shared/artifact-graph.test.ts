import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseArtifactGraphDocument } from '../../src/shared/artifact-graph.js';
import type { ArtifactGraphDocument } from '../../src/artifact-graph/contracts.js';

function graph(): ArtifactGraphDocument {
  return {
    documentKind: 'artifact-graph',
    schemaVersion: 1,
    graphId: 'eval:test',
    generatedAt: '2026-07-27T00:00:00.000Z',
    source: { sourceKind: 'eval', sourceId: 'report-test' },
    scope: { cwd: '/tmp', artifactKind: 'skill', skillName: 'test' },
    nodes: [
      {
        id: 'skill',
        stableKey: 'v1:skill:test',
        nodeKind: 'skill',
        nodeRole: 'entity',
        layer: 'measurement',
        label: 'test',
      },
      {
        id: 'sample',
        stableKey: 'v1:sample:s1',
        nodeKind: 'sample',
        nodeRole: 'entity',
        layer: 'measurement',
        label: 's1',
      },
    ],
    edges: [{
      id: 'covers',
      fromNodeId: 'sample',
      toNodeId: 'skill',
      edgeKind: 'covers',
      layer: 'measurement',
    }],
  };
}

describe('parseArtifactGraphDocument', () => {
  it('accepts a valid graph with referential integrity', () => {
    assert.deepEqual(parseArtifactGraphDocument(graph()), graph());
  });

  it('rejects unknown enums before they reach renderer attributes', () => {
    const malformed = structuredClone(graph()) as unknown as {
      nodes: Array<{ status?: string }>;
    };
    malformed.nodes[0].status = 'ok" onclick="alert(1)';
    assert.equal(parseArtifactGraphDocument(malformed), null);
  });

  it('rejects duplicate identities and dangling edges', () => {
    const duplicate = structuredClone(graph());
    duplicate.nodes[1].id = duplicate.nodes[0].id;
    assert.equal(parseArtifactGraphDocument(duplicate), null);

    const dangling = structuredClone(graph());
    dangling.edges[0].toNodeId = 'missing';
    assert.equal(parseArtifactGraphDocument(dangling), null);
  });
});
