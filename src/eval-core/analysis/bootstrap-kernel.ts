/** 一个独立重采样组：配对差、整簇均值、分层或独立实验臂由调用方先行构造。 */
export interface BootstrapGroup {
  readonly values: readonly number[];
  /** 返回当前组内的索引；随机流与种子派生属于版本化的估计器策略。 */
  indexFor(replicate: number, draw: number): number;
}

/** 固定整数种子的 Mulberry32 策略；每次调用创建独立随机流。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 共同的有放回抽样循环。组序、组内抽样数与浮点累加顺序不能改变。 */
export function bootstrapDistribution(
  groups: readonly BootstrapGroup[],
  resamples: number,
  statistic: (samples: number[][]) => number,
): number[] {
  const distribution: number[] = new Array(resamples);
  for (let replicate = 0; replicate < resamples; replicate += 1) {
    const samples = groups.map((group) => {
      const sampled: number[] = new Array(group.values.length);
      for (let draw = 0; draw < group.values.length; draw += 1) {
        sampled[draw] = group.values[group.indexFor(replicate, draw)];
      }
      return sampled;
    });
    distribution[replicate] = statistic(samples);
  }
  return distribution;
}

/** 空输入的领域策略由调用边界决定。 */
export function arithmeticMean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 已排序分布的线性插值；空分布保留产品历史投影的零值。 */
export function linearQuantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** 不修改原始抽样证据；舍入、缺失与判定语义由版本化调用方拥有。 */
export function percentileBounds(
  distribution: readonly number[],
  alpha: number,
): { lower: number; upper: number } {
  const sorted = [...distribution].sort((left, right) => left - right);
  return {
    lower: linearQuantile(sorted, alpha / 2),
    upper: linearQuantile(sorted, 1 - alpha / 2),
  };
}
