import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../../../src/evaluation-core/contracts/index.js';
import { captureClassifiedEnvironment } from '../../../../../src/eval-workflows/runtime-adapter/adapters/shared/classified-environment.js';

describe('classified environment', () => {
  it('makes effect locator values identity-bearing without exposing them', () => {
    const endpoint = 'https://provider.example.test/v1/messages';
    const captured = captureClassifiedEnvironment({
      PROVIDER_ENDPOINT: {
        value: endpoint,
        identity: { identityKind: 'effect-locator' },
      },
    });

    expect(captured.identity).toEqual([{
      keyDigest: digestCanonicalJson('PROVIDER_ENDPOINT'),
      identityKind: 'effect-locator',
      valueDigest: digestCanonicalJson(endpoint),
    }]);
    expect(JSON.stringify(captured.identity)).not.toContain(endpoint);
    expect(captured.outputClassification).toBe('sensitive');
  });

  it('keeps credential values out of identity', () => {
    const first = captureClassifiedEnvironment({
      PROVIDER_API_KEY: {
        value: 'credential-a',
        identity: { identityKind: 'credential' },
      },
    });
    const second = captureClassifiedEnvironment({
      PROVIDER_API_KEY: {
        value: 'credential-b',
        identity: { identityKind: 'credential' },
      },
    });

    expect(first.identity).toEqual(second.identity);
    expect(JSON.stringify(first.identity)).not.toContain('credential-a');
    expect(first.outputClassification).toBe('secret');
  });

  it('keeps effect-locator identity independent from output secrecy', () => {
    const proxy = 'http://user:password@proxy.example.test:8080';
    const captured = captureClassifiedEnvironment({
      HTTPS_PROXY: {
        value: proxy,
        identity: { identityKind: 'effect-locator' },
        outputTaint: 'secret',
      },
    });

    expect(captured.identity).toEqual([{
      keyDigest: digestCanonicalJson('HTTPS_PROXY'),
      identityKind: 'effect-locator',
      valueDigest: digestCanonicalJson(proxy),
      outputTaint: 'secret',
    }]);
    expect(JSON.stringify(captured.identity)).not.toContain(proxy);
    expect(captured.outputClassification).toBe('secret');
  });
});
