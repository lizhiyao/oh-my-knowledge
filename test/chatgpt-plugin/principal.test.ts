import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  assertObservationAccessScope,
  assertObservationCaptureScope,
  assertObservationDraftScope,
  assertObservationReadScope,
  assertObservationReviewScope,
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  ObservationPrincipalError,
  validateObservationPrincipal,
} from '../../src/chatgpt-plugin/principal.js';

describe('observation principal', () => {
  it('accepts opaque host identities without assigning identity semantics', () => {
    assert.deepEqual(validateObservationPrincipal({
      tenantId: 'tenant-opaque-1',
      principalId: 'subject-opaque-9',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    }), {
      tenantId: 'tenant-opaque-1',
      principalId: 'subject-opaque-9',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    });
  });

  it('rejects malformed identities and missing capture scope', () => {
    assert.throws(
      () => validateObservationPrincipal({
        tenantId: '../tenant',
        principalId: ' subject ',
        scopes: [OBSERVATION_CAPTURE_SCOPE],
      }),
      (error: unknown) => error instanceof ObservationPrincipalError
        && error.code === 'invalid_principal',
    );
    assert.throws(
      () => assertObservationCaptureScope({
        tenantId: 'tenant',
        principalId: 'subject',
        scopes: [],
      }),
      (error: unknown) => error instanceof ObservationPrincipalError
        && error.code === 'forbidden',
    );
  });

  it('keeps read, review, and draft permissions independent', () => {
    const principal = {
      tenantId: 'tenant',
      principalId: 'subject',
      scopes: [OBSERVATION_READ_SCOPE, OBSERVATION_REVIEW_SCOPE],
    };
    assert.doesNotThrow(() => assertObservationAccessScope(principal));
    assert.doesNotThrow(() => assertObservationReadScope(principal));
    assert.doesNotThrow(() => assertObservationReviewScope(principal));
    assert.throws(() => assertObservationCaptureScope(principal), ObservationPrincipalError);
    assert.throws(() => assertObservationDraftScope(principal), ObservationPrincipalError);
    assert.equal(OBSERVATION_DRAFT_SCOPE, 'observation:draft');
  });
});
