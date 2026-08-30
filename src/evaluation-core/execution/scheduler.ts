import {
  canonicalizeJson,
  derivePlannedExecutionCoordinates,
  digestCanonicalJson,
  type PlannedExecutionCoordinate,
} from '../contracts/index.js';
import type { SealedRunPlan } from '../compiler/index.js';

export interface ExecutionSchedulingBlock {
  schedulingBlockId: string;
  coordinates: readonly PlannedExecutionCoordinate[];
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function interleavedOrder(
  left: ExecutionSchedulingBlock,
  right: ExecutionSchedulingBlock,
): number {
  const leftCoordinate = left.coordinates[0];
  const rightCoordinate = right.coordinates[0];
  return leftCoordinate.trialIndex - rightCoordinate.trialIndex
    || compareStrings(leftCoordinate.sampleId, rightCoordinate.sampleId)
    || compareStrings(leftCoordinate.randomizationSlotId, rightCoordinate.randomizationSlotId);
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length < 2) return [...values];
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function randomRank(
  randomizationDesignDigest: string,
  scope: 'coordinate' | 'block',
  identity: unknown,
): string {
  return digestCanonicalJson({
    derivation: 'omk.execution-schedule-rank/v1',
    randomizationDesignDigest,
    scope,
    identity,
  });
}

function randomizedBlocks(
  blocks: readonly ExecutionSchedulingBlock[],
  randomizationDesignDigest: string,
  blockSize: number,
): ExecutionSchedulingBlock[] {
  const batches: ExecutionSchedulingBlock[][] = [];
  let batch: ExecutionSchedulingBlock[] = [];
  let coordinateCount = 0;
  for (const block of blocks) {
    if (block.coordinates.length > blockSize) {
      throw new TypeError('randomized-block blockSize cannot split a scheduling block');
    }
    if (coordinateCount > 0 && coordinateCount + block.coordinates.length > blockSize) {
      batches.push(batch);
      batch = [];
      coordinateCount = 0;
    }
    batch.push(block);
    coordinateCount += block.coordinates.length;
  }
  if (batch.length > 0) batches.push(batch);

  return batches.flatMap((currentBatch, batchIndex) => (
    currentBatch
      .map((block) => ({
        ...block,
        coordinates: [...block.coordinates].sort((left, right) => compareStrings(
          randomRank(randomizationDesignDigest, 'coordinate', {
            trialIndex: left.trialIndex,
            sampleId: left.sampleId,
            randomizationSlotId: left.randomizationSlotId,
          }),
          randomRank(randomizationDesignDigest, 'coordinate', {
            trialIndex: right.trialIndex,
            sampleId: right.sampleId,
            randomizationSlotId: right.randomizationSlotId,
          }),
        )),
      }))
      .sort((left, right) => compareStrings(
        randomRank(randomizationDesignDigest, 'block', {
          batchIndex,
          coordinates: left.coordinates.map((coordinate) => ({
            trialIndex: coordinate.trialIndex,
            sampleId: coordinate.sampleId,
            randomizationSlotId: coordinate.randomizationSlotId,
          })).sort((first, second) => compareStrings(
            canonicalizeJson(first),
            canonicalizeJson(second),
          )),
        }),
        randomRank(randomizationDesignDigest, 'block', {
          batchIndex,
          coordinates: right.coordinates.map((coordinate) => ({
            trialIndex: coordinate.trialIndex,
            sampleId: coordinate.sampleId,
            randomizationSlotId: coordinate.randomizationSlotId,
          })).sort((first, second) => compareStrings(
            canonicalizeJson(first),
            canonicalizeJson(second),
          )),
        }),
      ))
  ));
}

export function deriveExecutionSchedule(plan: SealedRunPlan): ExecutionSchedulingBlock[] {
  const coordinates = derivePlannedExecutionCoordinates(plan);
  const byBlock = new Map<string, PlannedExecutionCoordinate[]>();
  for (const coordinate of coordinates) {
    const block = byBlock.get(coordinate.schedulingBlockId) ?? [];
    block.push(coordinate);
    byBlock.set(coordinate.schedulingBlockId, block);
  }
  const blocks = [...byBlock.entries()].map(([schedulingBlockId, members]) => ({
    schedulingBlockId,
    coordinates: members,
  }));
  const { scheduling } = plan.execution.experiment;
  if (scheduling.schedulingKind === 'sequential') return blocks;

  const interleaved = blocks.sort(interleavedOrder).map((block, index) => ({
    ...block,
    coordinates: rotate(block.coordinates, index),
  }));
  if (scheduling.schedulingKind === 'interleaved') return interleaved;
  if (scheduling.blockSize === undefined) {
    throw new TypeError('randomized-block scheduling requires blockSize');
  }
  return randomizedBlocks(
    interleaved,
    plan.execution.randomizationDesignDigest,
    scheduling.blockSize,
  );
}
