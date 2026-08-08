import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createHorizontalObstacleIndex,
  planFlowMarkerProgresses,
  planFlowRoute,
  queryHorizontalObstacleIndex,
  renderTrajectoryRoutingClientSource,
  routingQuadraticHitsRect,
  type RoutingRect,
} from '../../src/renderer/trajectory-routing.js';

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
  owner: string,
): RoutingRect<string> {
  return { left, right: left + width, top, bottom: top + height, owner };
}

describe('trajectory routing', () => {
  it('places compact flow markers near the destination while preserving their order', () => {
    assert.deepEqual(planFlowMarkerProgresses(500, 1), [0.944]);
    assert.deepEqual(planFlowMarkerProgresses(500, 3), [0.808, 0.876, 0.944]);
    assert.deepEqual(planFlowMarkerProgresses(60, 1), [0.7]);
    assert.deepEqual(planFlowMarkerProgresses(0, 1), []);
  });

  it('indexes obstacles by horizontal time range without returning duplicates', () => {
    const nearby = rect(100, 20, 180, 60, 'nearby');
    const farAway = rect(4_000, 20, 180, 60, 'far-away');
    const index = createHorizontalObstacleIndex([nearby, farAway], 120);

    assert.deepEqual(queryHorizontalObstacleIndex(index, 90, 300), [nearby]);
    assert.deepEqual(queryHorizontalObstacleIndex(index, 3_900, 4_300), [farAway]);
  });

  it('stops at a clear straight route before evaluating curves or corridors', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 20, 100, 50, 'to');
    const farObstacles = Array.from({ length: 1_000 }, (_value, index) =>
      rect(10_000 + index * 120, 0, 80, 80, `far-${index}`));
    const route = planFlowRoute({
      fromRect: from,
      toRect: to,
      fromLane: 'conversation',
      toLane: 'conversation',
      obstacleIndex: createHorizontalObstacleIndex([from, to, ...farObstacles]),
      fromOwner: 'from',
      toOwner: 'to',
    });

    assert.equal(route?.routeKind, 'straight');
    assert.equal(route?.metrics.curveCandidates, 0);
    assert.equal(route?.metrics.corridorCandidates, 0);
    assert.equal(route?.metrics.obstacleCandidates, 0);
  });

  it('uses the first collision-free curve and leaves corridor planning lazy', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 260, 100, 50, 'to');
    const obstacle = rect(150, -20, 100, 90, 'obstacle');
    const route = planFlowRoute({
      fromRect: from,
      toRect: to,
      fromLane: 'conversation',
      toLane: 'action',
      obstacleIndex: createHorizontalObstacleIndex([from, to, obstacle]),
      fromOwner: 'from',
      toOwner: 'to',
    });

    assert.equal(route?.routeKind, 'quadratic');
    assert.equal(route?.metrics.curveCandidates, 1);
    assert.equal(route?.metrics.corridorCandidates, 0);
    assert.ok(route);
    assert.equal(routingQuadraticHitsRect(route.from, route.arrowFrom, route.to, obstacle), false);
  });

  it('keeps the browser-injected routing core executable from the typed source of truth', () => {
    const source = renderTrajectoryRoutingClientSource();
    const browserFunctions = Function(
      `${source}; return { createHorizontalObstacleIndex, planFlowMarkerProgresses, planFlowRoute };`,
    )() as { createHorizontalObstacleIndex: unknown; planFlowMarkerProgresses: unknown; planFlowRoute: unknown };

    assert.equal(typeof browserFunctions.createHorizontalObstacleIndex, 'function');
    assert.equal(typeof browserFunctions.planFlowMarkerProgresses, 'function');
    assert.equal(typeof browserFunctions.planFlowRoute, 'function');
  });
});
