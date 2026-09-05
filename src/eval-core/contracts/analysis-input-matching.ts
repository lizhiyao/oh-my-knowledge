/**
 * A comparison normally applies only to observations of its own Metric. A derived
 * composite comparison instead applies its sealed contrast to every declared
 * source Metric so the Runtime can materialize the two arms before derivation.
 *
 * This is an internal contract projection shared by runtime materialization and
 * persisted Bundle verification. It is intentionally not exported by contracts/index.
 */
export function analysisComparisonAppliesToMetricInput(
  node: Readonly<{ parameters?: unknown }>,
  comparisonMetricId: string,
  inputMetricId: string,
): boolean {
  if (comparisonMetricId === inputMetricId) return true;
  const parameters = node.parameters;
  if (parameters === undefined || parameters === null || Array.isArray(parameters)
      || typeof parameters !== 'object') return false;
  const parameterObject = parameters as Record<string, unknown>;
  if (parameterObject.compositeMetricId !== comparisonMetricId
      || !Array.isArray(parameterObject.components)) return false;
  return parameterObject.components.some((component) => (
    component !== null && !Array.isArray(component) && typeof component === 'object'
      && (component as Record<string, unknown>).metricId === inputMetricId
  ));
}
