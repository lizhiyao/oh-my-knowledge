import { digestCanonicalJson } from '../../../src/eval-core/contracts/index.js';
import { describe, expect, it } from 'vitest';
import { classifyNodeCliEnvironment } from '../../../src/cli/lib/evaluation-composition.js';
import { captureClassifiedEnvironment } from '../../../src/eval-workflows/hosts/adapters/shared/classified-environment.js';

describe('Node CLI production environment', () => {
  it('preserves network routing and trust locators for isolated runtime processes', () => {
    const proxy = 'http://user:password@127.0.0.1:7890';
    const classified = classifyNodeCliEnvironment({
      PATH: '/usr/bin:/bin',
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
      NODE_OPTIONS: '--require=/tmp/untrusted.js',
    });

    expect(Object.keys(classified)).toEqual([
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'PATH',
      'https_proxy',
    ]);
    expect(classified.https_proxy).toEqual({
      value: proxy,
      identity: { identityKind: 'effect-locator' },
      outputTaint: 'secret',
    });
    expect(classified.NODE_OPTIONS).toBeUndefined();

    const captured = captureClassifiedEnvironment(classified);
    expect(captured.values.https_proxy).toBe(proxy);
    expect(captured.identity).toContainEqual({
      keyDigest: digestCanonicalJson('https_proxy'),
      identityKind: 'effect-locator',
      valueDigest: digestCanonicalJson(proxy),
      outputTaint: 'secret',
    });
    expect(JSON.stringify(captured.identity)).not.toContain(proxy);
    expect(captured.outputClassification).toBe('secret');
  });

  it('supports conventional upper- and lower-case proxy variables without broad inheritance', () => {
    const classified = classifyNodeCliEnvironment({
      ALL_PROXY: 'socks5://proxy.example.test:1080',
      HTTPS_PROXY: 'http://proxy.example.test:8443',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      all_proxy: 'socks5://proxy.example.test:1081',
      http_proxy: 'http://proxy.example.test:8081',
      https_proxy: 'http://proxy.example.test:8444',
      no_proxy: 'localhost',
      UNRELATED_SECRET: 'must-not-cross-runtime-boundary',
    });

    expect(Object.keys(classified)).toEqual([
      'ALL_PROXY',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'all_proxy',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]);
    expect(classified.UNRELATED_SECRET).toBeUndefined();
  });
});
