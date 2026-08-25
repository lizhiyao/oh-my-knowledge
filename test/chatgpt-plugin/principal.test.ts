import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  assertObservationCaptureScope,
  OBSERVATION_CAPTURE_SCOPE,
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
});
