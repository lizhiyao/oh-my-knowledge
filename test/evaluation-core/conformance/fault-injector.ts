export type ConformanceFaultBoundary =
  | 'resolve-executor'
  | 'resolve-evaluator'
  | 'resolve-analysis'
  | 'executor-open-run'
  | 'executor-open-trial'
  | 'executor-execute'
  | 'executor-dispose-trial'
  | 'executor-dispose-run'
  | 'evaluator-open-run'
  | 'evaluator-open-record'
  | 'evaluator-evaluate'
  | 'evaluator-dispose-record'
  | 'evaluator-dispose-run'
  | 'analysis-open-run'
  | 'analysis-execute'
  | 'analysis-dispose-run'
  | 'decision-decide'
  | 'event-write'
  | 'content-put'
  | 'content-resolve'
  | 'cache-get'
  | 'cache-put';

type FaultAction = () => void | Promise<void>;

interface ArmedFault {
  occurrence: number;
  action: FaultAction;
}

export class ConformanceFaultInjector {
  readonly #counts = new Map<ConformanceFaultBoundary, number>();
  readonly #faults = new Map<ConformanceFaultBoundary, ArmedFault[]>();

  at(
    boundary: ConformanceFaultBoundary,
    action: FaultAction,
    occurrence = 1,
  ): this {
    const faults = this.#faults.get(boundary) ?? [];
    faults.push({ occurrence, action });
    this.#faults.set(boundary, faults);
    return this;
  }

  fail(
    boundary: ConformanceFaultBoundary,
    message = `Injected failure at ${boundary}.`,
    occurrence = 1,
  ): this {
    return this.at(boundary, () => { throw new Error(message); }, occurrence);
  }

  count(boundary: ConformanceFaultBoundary): number {
    return this.#counts.get(boundary) ?? 0;
  }

  async hit(boundary: ConformanceFaultBoundary): Promise<void> {
    const occurrence = this.count(boundary) + 1;
    this.#counts.set(boundary, occurrence);
    for (const fault of this.#faults.get(boundary) ?? []) {
      if (fault.occurrence === occurrence) await fault.action();
    }
  }
}

export function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
