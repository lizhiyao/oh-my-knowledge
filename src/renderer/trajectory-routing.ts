export interface RoutingPoint {
  x: number;
  y: number;
}

export interface RoutingRect<Owner = unknown> {
  left: number;
  right: number;
  top: number;
  bottom: number;
  owner?: Owner;
}

export interface HorizontalObstacleIndex<Owner = unknown> {
  bucketSize: number;
  buckets: Map<number, RoutingRect<Owner>[]>;
  all: RoutingRect<Owner>[];
}

export interface FlowRouteMetrics {
  obstacleQueries: number;
  obstacleCandidates: number;
  collisionChecks: number;
  curveCandidates: number;
  corridorCandidates: number;
}

export interface FlowRoutePlan {
  routeKind: 'straight' | 'quadratic' | 'corridor';
  d: string;
  from: RoutingPoint;
  to: RoutingPoint;
  arrowFrom: RoutingPoint;
  metrics: FlowRouteMetrics;
}

export interface FlowRouteRequest<Owner = unknown> {
  fromRect: RoutingRect<Owner>;
  toRect: RoutingRect<Owner>;
  fromLane: string;
  toLane: string;
  obstacleIndex: HorizontalObstacleIndex<Owner>;
  fromOwner?: Owner;
  toOwner?: Owner;
}

export function planFlowMarkerProgresses(pathLength: number, markerCount: number): number[] {
  if (!Number.isFinite(pathLength) || pathLength <= 0 || !Number.isFinite(markerCount) || markerCount <= 0) return [];
  const length = Math.max(1, pathLength);
  const count = Math.max(1, Math.floor(markerCount));
  const minimumEndpointOffset = Math.min(18, length / 2);
  const closestDistanceFromEnd = Math.max(
    minimumEndpointOffset,
    Math.min(28, length * .28),
  );
  const furthestDistanceFromEnd = Math.max(closestDistanceFromEnd, length - minimumEndpointOffset);
  const spacing = count > 1
    ? Math.min(34, (furthestDistanceFromEnd - closestDistanceFromEnd) / (count - 1))
    : 0;
  return Array.from({ length: count }, (_value, markerIndex) => {
    const distanceFromEnd = closestDistanceFromEnd + spacing * (count - markerIndex - 1);
    return Math.max(0, Math.min(1, 1 - distanceFromEnd / length));
  });
}

export function createHorizontalObstacleIndex<Owner>(
  rects: RoutingRect<Owner>[],
  bucketSize = 240,
): HorizontalObstacleIndex<Owner> {
  const safeBucketSize = Math.max(32, bucketSize);
  const buckets = new Map<number, RoutingRect<Owner>[]>();
  rects.forEach((rect) => {
    const firstBucket = Math.floor(rect.left / safeBucketSize);
    const lastBucket = Math.floor(rect.right / safeBucketSize);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const entries = buckets.get(bucket) ?? [];
      entries.push(rect);
      buckets.set(bucket, entries);
    }
  });
  return { bucketSize: safeBucketSize, buckets, all: rects };
}

export function queryHorizontalObstacleIndex<Owner>(
  index: HorizontalObstacleIndex<Owner>,
  minX: number,
  maxX: number,
  minY = Number.NEGATIVE_INFINITY,
  maxY = Number.POSITIVE_INFINITY,
): RoutingRect<Owner>[] {
  const left = Math.min(minX, maxX);
  const right = Math.max(minX, maxX);
  const top = Math.min(minY, maxY);
  const bottom = Math.max(minY, maxY);
  const firstBucket = Math.floor(left / index.bucketSize);
  const lastBucket = Math.floor(right / index.bucketSize);
  const seen = new Set<RoutingRect<Owner>>();
  const matches: RoutingRect<Owner>[] = [];
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    for (const rect of index.buckets.get(bucket) ?? []) {
      if (seen.has(rect)) continue;
      seen.add(rect);
      if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue;
      matches.push(rect);
    }
  }
  return matches;
}

export function routingPointInsideRect(point: RoutingPoint, rect: RoutingRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function routingLineHitsRect(
  fromPoint: RoutingPoint,
  toPoint: RoutingPoint,
  rect: RoutingRect,
): boolean {
  if (routingPointInsideRect(fromPoint, rect) || routingPointInsideRect(toPoint, rect)) return true;
  const direction = { x: toPoint.x - fromPoint.x, y: toPoint.y - fromPoint.y };
  let entry = 0;
  let exit = 1;
  const boundaries = [
    { coefficient: -direction.x, distance: fromPoint.x - rect.left },
    { coefficient: direction.x, distance: rect.right - fromPoint.x },
    { coefficient: -direction.y, distance: fromPoint.y - rect.top },
    { coefficient: direction.y, distance: rect.bottom - fromPoint.y },
  ];
  for (const boundary of boundaries) {
    if (boundary.coefficient === 0) {
      if (boundary.distance < 0) return false;
      continue;
    }
    const ratio = boundary.distance / boundary.coefficient;
    if (boundary.coefficient < 0) entry = Math.max(entry, ratio);
    else exit = Math.min(exit, ratio);
    if (entry > exit) return false;
  }
  return entry <= exit && exit >= 0 && entry <= 1;
}

export function routingQuadraticHitsRect(
  fromPoint: RoutingPoint,
  control: RoutingPoint,
  toPoint: RoutingPoint,
  rect: RoutingRect,
): boolean {
  const minX = Math.min(fromPoint.x, control.x, toPoint.x);
  const maxX = Math.max(fromPoint.x, control.x, toPoint.x);
  const minY = Math.min(fromPoint.y, control.y, toPoint.y);
  const maxY = Math.max(fromPoint.y, control.y, toPoint.y);
  if (rect.right < minX || rect.left > maxX || rect.bottom < minY || rect.top > maxY) return false;
  for (let sampleIndex = 1; sampleIndex < 40; sampleIndex += 1) {
    const progress = sampleIndex / 40;
    const inverse = 1 - progress;
    const x = inverse * inverse * fromPoint.x + 2 * inverse * progress * control.x + progress * progress * toPoint.x;
    const y = inverse * inverse * fromPoint.y + 2 * inverse * progress * control.y + progress * progress * toPoint.y;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

export function routingMoveToward(fromPoint: RoutingPoint, toPoint: RoutingPoint, distance: number): RoutingPoint {
  const dx = toPoint.x - fromPoint.x;
  const dy = toPoint.y - fromPoint.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: fromPoint.x + dx / length * distance,
    y: fromPoint.y + dy / length * distance,
  };
}

export function routingEdgePoint(rect: RoutingRect, targetX: number, targetY: number): RoutingPoint {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (width / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (height / 2) / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

export function routingConnectionPoints(fromRect: RoutingRect, toRect: RoutingRect): { from: RoutingPoint; to: RoutingPoint } {
  const fromCenter = { x: (fromRect.left + fromRect.right) / 2, y: (fromRect.top + fromRect.bottom) / 2 };
  const toCenter = { x: (toRect.left + toRect.right) / 2, y: (toRect.top + toRect.bottom) / 2 };
  const from = routingEdgePoint(fromRect, toCenter.x, toCenter.y);
  const to = routingEdgePoint(toRect, fromCenter.x, fromCenter.y);
  return {
    from: routingMoveToward(from, toCenter, 2),
    to: routingMoveToward(to, fromCenter, 2),
  };
}

export function routingRectPort(rect: RoutingRect, side: 'left' | 'right' | 'top' | 'bottom'): RoutingPoint {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  if (side === 'left') return { x: rect.left, y: centerY };
  if (side === 'right') return { x: rect.right, y: centerY };
  if (side === 'top') return { x: centerX, y: rect.top };
  return { x: centerX, y: rect.bottom };
}

export function routingFlowControlPoint(
  points: { from: RoutingPoint; to: RoutingPoint },
  requestedBend?: number,
  side = 1,
): RoutingPoint {
  const dx = points.to.x - points.from.x;
  const dy = points.to.y - points.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;
  const forwardAdvance = Math.max(0, dx);
  const naturalBend = Math.min(12, length * .06, forwardAdvance * .45);
  const bend = requestedBend ?? naturalBend;
  const bendDirection = normalX === 0 ? 1 : Math.sign(normalX);
  return {
    x: (points.from.x + points.to.x) / 2 + normalX * bend * bendDirection * side,
    y: (points.from.y + points.to.y) / 2 + normalY * bend * bendDirection * side,
  };
}

export function routingRoundedPolylinePath(routePoints: RoutingPoint[], radius = 10): string {
  if (routePoints.length < 2) return '';
  let d = `M ${routePoints[0].x} ${routePoints[0].y}`;
  for (let pointIndex = 1; pointIndex < routePoints.length - 1; pointIndex += 1) {
    const previous = routePoints[pointIndex - 1];
    const corner = routePoints[pointIndex];
    const next = routePoints[pointIndex + 1];
    const cornerRadius = Math.min(
      radius,
      Math.hypot(corner.x - previous.x, corner.y - previous.y) / 2,
      Math.hypot(next.x - corner.x, next.y - corner.y) / 2,
    );
    const entry = routingMoveToward(corner, previous, cornerRadius);
    const exit = routingMoveToward(corner, next, cornerRadius);
    d += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
  }
  const last = routePoints[routePoints.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

export function planFlowRoute<Owner>(request: FlowRouteRequest<Owner>): FlowRoutePlan | undefined {
  const { fromRect, toRect, fromLane, toLane, obstacleIndex, fromOwner, toOwner } = request;
  const metrics: FlowRouteMetrics = {
    obstacleQueries: 0,
    obstacleCandidates: 0,
    collisionChecks: 0,
    curveCandidates: 0,
    corridorCandidates: 0,
  };
  const queryObstacles = (minX: number, maxX: number, minY: number, maxY: number): RoutingRect<Owner>[] => {
    metrics.obstacleQueries += 1;
    const matches = queryHorizontalObstacleIndex(obstacleIndex, minX, maxX, minY, maxY)
      .filter((rect) => rect.owner !== fromOwner && rect.owner !== toOwner);
    metrics.obstacleCandidates += matches.length;
    return matches;
  };
  const lineIsClear = (from: RoutingPoint, to: RoutingPoint): boolean => {
    const candidates = queryObstacles(from.x, to.x, from.y, to.y);
    return !candidates.some((rect) => {
      metrics.collisionChecks += 1;
      return routingLineHitsRect(from, to, rect);
    });
  };
  const points = routingConnectionPoints(fromRect, toRect);
  const direct = fromLane === toLane && Math.abs(points.to.y - points.from.y) < 4;
  if (direct && lineIsClear(points.from, points.to)) {
    return {
      routeKind: 'straight',
      d: `M ${points.from.x} ${points.from.y} L ${points.to.x} ${points.to.y}`,
      from: points.from,
      to: points.to,
      arrowFrom: points.from,
      metrics,
    };
  }

  const fromCenter = { x: (fromRect.left + fromRect.right) / 2, y: (fromRect.top + fromRect.bottom) / 2 };
  const toCenter = { x: (toRect.left + toRect.right) / 2, y: (toRect.top + toRect.bottom) / 2 };
  const verticalFromSide = toCenter.y < fromCenter.y ? 'top' : 'bottom';
  const verticalToSide = toCenter.y < fromCenter.y ? 'bottom' : 'top';
  const horizontalFromSide = toCenter.x < fromCenter.x ? 'left' : 'right';
  const horizontalToSide = toCenter.x < fromCenter.x ? 'right' : 'left';
  const pointPairs = [
    { points, penalty: 0 },
    { points: { from: routingRectPort(fromRect, horizontalFromSide), to: routingRectPort(toRect, verticalToSide) }, penalty: 8 },
    { points: { from: routingRectPort(fromRect, verticalFromSide), to: routingRectPort(toRect, verticalToSide) }, penalty: 12 },
    { points: { from: routingRectPort(fromRect, horizontalFromSide), to: routingRectPort(toRect, horizontalToSide) }, penalty: 14 },
    {
      points: {
        from: routingRectPort(fromRect, horizontalFromSide === 'left' ? 'right' : 'left'),
        to: routingRectPort(toRect, verticalToSide),
      },
      penalty: 22,
    },
  ];
  const bendCandidates = [
    { bend: undefined, side: 1, penalty: 0 },
    ...[20, 32, 48, 68, 92, 120, 156, 198].map((bend) => ({ bend, side: 1, penalty: bend * .18 })),
    ...[20, 32, 48, 68, 92, 120, 156, 198].map((bend) => ({ bend, side: -1, penalty: 24 + bend * .2 })),
  ];
  const curveCandidates = pointPairs.flatMap((pair) => bendCandidates.map((bendCandidate) => {
    const control = routingFlowControlPoint(pair.points, bendCandidate.bend, bendCandidate.side);
    const distance = Math.hypot(pair.points.to.x - pair.points.from.x, pair.points.to.y - pair.points.from.y);
    return {
      ...pair.points,
      control,
      score: distance + pair.penalty + bendCandidate.penalty,
    };
  })).sort((left, right) => left.score - right.score);
  for (const candidate of curveCandidates) {
    metrics.curveCandidates += 1;
    const obstacles = queryObstacles(
      Math.min(candidate.from.x, candidate.control.x, candidate.to.x),
      Math.max(candidate.from.x, candidate.control.x, candidate.to.x),
      Math.min(candidate.from.y, candidate.control.y, candidate.to.y),
      Math.max(candidate.from.y, candidate.control.y, candidate.to.y),
    );
    const blocked = obstacles.some((rect) => {
      metrics.collisionChecks += 1;
      return routingQuadraticHitsRect(candidate.from, candidate.control, candidate.to, rect);
    });
    if (!blocked) {
      return {
        routeKind: 'quadratic',
        d: `M ${candidate.from.x} ${candidate.from.y} Q ${candidate.control.x} ${candidate.control.y} ${candidate.to.x} ${candidate.to.y}`,
        from: candidate.from,
        to: candidate.to,
        arrowFrom: candidate.control,
        metrics,
      };
    }
  }

  if (fromLane === toLane) return undefined;
  const allObstacles = obstacleIndex.all.filter((rect) => rect.owner !== fromOwner && rect.owner !== toOwner);
  const verticalTop = Math.min(points.from.y, points.to.y);
  const verticalBottom = Math.max(points.from.y, points.to.y);
  const intervals = allObstacles
    .filter((rect) => rect.bottom >= verticalTop && rect.top <= verticalBottom)
    .map((rect) => ({ left: rect.left, right: rect.right }))
    .sort((left, right) => left.left - right.left)
    .reduce<Array<{ left: number; right: number }>>((merged, interval) => {
      const previous = merged[merged.length - 1];
      if (!previous || interval.left > previous.right) merged.push({ ...interval });
      else previous.right = Math.max(previous.right, interval.right);
      return merged;
    }, []);
  const corridorXs = [points.from.x, points.to.x, (points.from.x + points.to.x) / 2];
  intervals.forEach((interval, intervalIndex) => {
    const next = intervals[intervalIndex + 1];
    if (next && next.left > interval.right) corridorXs.push((interval.right + next.left) / 2);
  });
  if (intervals.length > 0) {
    corridorXs.push(
      intervals[0].left - 16,
      intervals[0].left - 44,
      intervals[0].left - 76,
      intervals[intervals.length - 1].right + 16,
      intervals[intervals.length - 1].right + 44,
      intervals[intervals.length - 1].right + 76,
    );
  }
  const corridorPort = (rect: RoutingRect<Owner>, side: string, corridorX: number): RoutingPoint => {
    const inset = Math.min(14, (rect.right - rect.left) / 4);
    const centerY = (rect.top + rect.bottom) / 2;
    if (corridorX < rect.left + inset) return { x: rect.left - 2, y: centerY };
    if (corridorX > rect.right - inset) return { x: rect.right + 2, y: centerY };
    return {
      x: Math.max(rect.left + inset, Math.min(rect.right - inset, corridorX)),
      y: (side === 'top' ? rect.top : rect.bottom) + (side === 'top' ? -2 : 2),
    };
  };
  let bestCorridor: { routePoints: RoutingPoint[]; from: RoutingPoint; to: RoutingPoint; score: number } | undefined;
  for (const corridorX of [...new Set(corridorXs.map((value) => Math.round(value * 10) / 10))]) {
    metrics.corridorCandidates += 1;
    const fromPoint = corridorPort(fromRect, verticalFromSide, corridorX);
    const toPoint = corridorPort(toRect, verticalToSide, corridorX);
    const routePoints = [fromPoint, { x: corridorX, y: fromPoint.y }, { x: corridorX, y: toPoint.y }, toPoint]
      .filter((point, pointIndex, pointsList) => pointIndex === 0
        || Math.hypot(point.x - pointsList[pointIndex - 1].x, point.y - pointsList[pointIndex - 1].y) > 1);
    const segments = routePoints.slice(1).map((point, pointIndex) => ({ from: routePoints[pointIndex], to: point }));
    let blocked = false;
    for (const segment of segments) {
      if (!lineIsClear(segment.from, segment.to)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const routeLength = segments.reduce((sum, segment) => sum
      + Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y), 0);
    const backward = Math.max(0, Math.min(fromCenter.x, toCenter.x) - corridorX);
    const score = routeLength + backward * .3;
    if (!bestCorridor || score < bestCorridor.score) {
      bestCorridor = { routePoints, from: fromPoint, to: toPoint, score };
    }
  }
  if (!bestCorridor) return undefined;
  return {
    routeKind: 'corridor',
    d: routingRoundedPolylinePath(bestCorridor.routePoints),
    from: bestCorridor.from,
    to: bestCorridor.to,
    arrowFrom: bestCorridor.routePoints[bestCorridor.routePoints.length - 2],
    metrics,
  };
}

export function renderTrajectoryRoutingClientSource(): string {
  // Studio 页面没有独立的客户端打包链路；序列化已类型检查的纯函数，避免维护第二份浏览器路由实现。
  return [
    planFlowMarkerProgresses,
    createHorizontalObstacleIndex,
    queryHorizontalObstacleIndex,
    routingPointInsideRect,
    routingLineHitsRect,
    routingQuadraticHitsRect,
    routingMoveToward,
    routingEdgePoint,
    routingConnectionPoints,
    routingRectPort,
    routingFlowControlPoint,
    routingRoundedPolylinePath,
    planFlowRoute,
  ].map((fn) => fn.toString()).join('\n');
}
