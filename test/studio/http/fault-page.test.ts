import { describe, expect, it } from 'vitest';
import { projectPageFault } from '../../../src/studio/http/page-fault.js';

describe('Studio page failure projection', () => {
  it('keeps the exact request for re-reading and scopes list recovery to the explicit workspace', () => {
    const request = '/measure/missing?workspace=%2Ftmp%2Fmy+project&tab=results&doctorRun=old';
    expect(projectPageFault('core_run_not_found', 'measure', request, true)).toEqual({
      faultCode: 'core_run_not_found', statusCode: 404, section: 'measure', returnTo: 'measure',
      returnHref: '/measure?workspace=%2Ftmp%2Fmy+project', retryHref: request,
    });
  });
  it('returns to a mounted list, without carrying unrelated or redirect query parameters', () => {
    expect(projectPageFault('doctor_run_not_found', 'knowledge', '/knowledge/skills/example?doctorRun=stale&next=https://evil.invalid', true))
      .toMatchObject({ statusCode: 404, returnHref: '/knowledge' });
    expect(projectPageFault('missing from/to query params', 'health', '/observe/health-diff?from=a&workspace=%2Ftmp', true))
      .toEqual({ faultCode: 'missing from/to query params', statusCode: 400, section: 'knowledge', returnTo: 'health', returnHref: '/observe/health?workspace=%2Ftmp' });
  });
  it.each(['studio_source_unavailable', 'core_studio_source_unavailable'] as const)('preserves source failure identity %s and HTTP 503', code => {
    expect(projectPageFault(code, 'inbox', '/observe/inbox', true)).toMatchObject({ faultCode: code, statusCode: 503, returnHref: '/observe/inbox' });
  });
  it('does not link unmounted siblings or add workspace scope in a Measure-only preview', () => {
    expect(projectPageFault('core_studio_source_unavailable', 'health', '/measure?workspace=%2Fother', false))
      .toEqual({ faultCode: 'core_studio_source_unavailable', statusCode: 503, section: 'measure', returnTo: 'measure', returnHref: '/measure', retryHref: '/measure?workspace=%2Fother' });
  });
});
