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
