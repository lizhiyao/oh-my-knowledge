import { createHash } from 'node:crypto';
import type { ExecutorArchiveProducer } from '../../../executors/contracts/archive.js';
import { EntityLinkReservationSchema, type EntityLinkExecutionRequest } from '../../../knowledge/entities/link-invocation.js';
import { entityLinkDigest } from '../entity-link-hash.js';
import { configuredEntityLinkExecutor, createEntityLinkExecutionRequest } from './entity-link-executor.js';
import { ENTITY_LINK_FILE_BYTES } from './entity-link-store.js';

export const entityLinkTextHash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
/** Delivery injects the concrete producer, not caller-supplied capacity numbers. */
export function inspectEntityLinkApiProducer(request: EntityLinkExecutionRequest, producer: ExecutorArchiveProducer) {
  // Recreate the same governed object the adapter sends: canonical persistence
  // sorts schema keys and must not change the concrete wire body on restart.
  const snapshot = createEntityLinkExecutionRequest(request, JSON.parse(request.prompt));
  const evidence = { ...producer.inspect(snapshot.executor, snapshot), requestDigest: request.requestDigest };
  const reservation = EntityLinkReservationSchema.parse({ ...evidence, reservationDigest: entityLinkDigest(evidence) });
  if (reservation.maxOutcomeJsonBytes > ENTITY_LINK_FILE_BYTES) throw new Error('Actual API diagnostic growth exceeds the entity-link archive quota; no invocation was started.');
  return reservation;
}
export function configureEntityLinkApiProducer(request: EntityLinkExecutionRequest, producer: ExecutorArchiveProducer) {
  const reservation = inspectEntityLinkApiProducer(request, producer);
  const snapshot = createEntityLinkExecutionRequest(request, JSON.parse(request.prompt));
  const configured = producer.configure(snapshot.executor, snapshot);
  const evidence = { ...configured.evidence, requestDigest: request.requestDigest };
  if (entityLinkDigest(evidence) !== reservation.reservationDigest) throw new Error('Producer context changed during configuration.');
  const adapter = configuredEntityLinkExecutor(request, { assertCapabilities: producer.assertCapabilities, create: () => configured.execute });
  return { reservation, execute: adapter.execute };
}
