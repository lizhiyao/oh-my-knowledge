import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createHorizontalObstacleIndex, planFlowRoute } from '../../../src/studio/application/replay/routing.js';
import type { RoutingRect } from '../../../src/studio/view-models/trajectory-routing.js';

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
  owner: string,
): RoutingRect<string> {
  return { left, right: left + width, top, bottom: top + height, owner };
}

/** 独立于实现的二阶贝塞尔采样：验证落地的连线本身没有穿过障碍。 */
function curveCrossesRect(
  from: { x: number; y: number },
  control: { x: number; y: number },
  to: { x: number; y: number },
  obstacle: RoutingRect<string>,
): boolean {
  for (let step = 0; step <= 64; step += 1) {
    const t = step / 64;
    const weight = (a: number, b: number, c: number): number =>
      (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
    const x = weight(from.x, control.x, to.x);
    const y = weight(from.y, control.y, to.y);
    if (x > obstacle.left && x < obstacle.right && y > obstacle.top && y < obstacle.bottom) return true;
  }
  return false;
}

function plan(
  from: RoutingRect<string>,
  to: RoutingRect<string>,
  obstacles: RoutingRect<string>[],
  options: { bucketSize?: number; lanes?: [string, string] } = {},
) {
  const [fromLane, toLane] = options.lanes ?? ['conversation', 'conversation'];
  return planFlowRoute({
    fromRect: from,
    toRect: to,
    fromLane,
    toLane,
    obstacleIndex: createHorizontalObstacleIndex([from, to, ...obstacles], options.bucketSize),
    fromOwner: 'from',
    toOwner: 'to',
  });
}

describe('trajectory flow routing', () => {
  it('stops at a clear straight route before evaluating curves or corridors', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 20, 100, 50, 'to');
    const farObstacles = Array.from({ length: 1_000 }, (_value, index) =>
      rect(10_000 + index * 120, 0, 80, 80, `far-${index}`));
    const route = plan(from, to, farObstacles);

    assert.equal(route?.routeKind, 'straight');
    assert.equal(route?.metrics.curveCandidates, 0);
    assert.equal(route?.metrics.corridorCandidates, 0);
    assert.equal(route?.metrics.obstacleCandidates, 0);
  });

  it('bends around an obstacle that blocks the straight line and stays lazy about corridors', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 20, 100, 50, 'to');
    const wall = rect(200, 20, 40, 50, 'wall');
    const route = plan(from, to, [wall]);
    assert.ok(route);

    assert.equal(route.routeKind, 'quadratic');
    // 直连被判定为不通后才会尝试曲线，且不会提前展开走廊规划。
    assert.ok(route.metrics.collisionChecks >= 1);
    assert.equal(route.metrics.corridorCandidates, 0);
    assert.equal(curveCrossesRect(route.from, route.arrowFrom, route.to, wall), false);
  });

  it('treats the obstacle bucket size as a pure accelerator', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 260, 100, 50, 'to');
    const obstacles = [rect(150, 100, 100, 60, 'obstacle')];
    const lanes: [string, string] = ['conversation', 'action'];
    const narrow = plan(from, to, obstacles, { bucketSize: 60, lanes });
    const wide = plan(from, to, obstacles, { bucketSize: 240, lanes });

    // 同一块障碍横跨多个桶，去重失效会让候选数随桶数增长。
    assert.ok(narrow && narrow.metrics.obstacleQueries > 1);
    assert.equal(narrow.metrics.obstacleCandidates, narrow.metrics.obstacleQueries);
    assert.deepEqual(narrow, wide);
  });

  it('drops the connection when no route avoids the obstacle', () => {
    const from = rect(0, 20, 100, 50, 'from');
    const to = rect(320, 20, 100, 50, 'to');

    // 同泳道且整条通道被高墙封死时宁可不画，也不画出穿过障碍的连线。
    assert.equal(plan(from, to, [rect(200, -600, 40, 1_200, 'wall')]), undefined);
  });
});
