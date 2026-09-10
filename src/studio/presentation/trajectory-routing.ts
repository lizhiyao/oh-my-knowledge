import { planFlowMarkerProgresses, createHorizontalObstacleIndex, queryHorizontalObstacleIndex, routingPointInsideRect, routingLineHitsRect, routingQuadraticHitsRect, routingMoveToward, routingEdgePoint, routingConnectionPoints, routingRectPort, routingFlowControlPoint, routingRoundedPolylinePath, planFlowRoute } from '../application/replay/routing.js';

export function renderTrajectoryRoutingClientSource(): string {
  // 独立 HTML 报告没有 React 客户端打包链路；序列化已类型检查的纯函数，避免维护第二份浏览器路由实现。
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
