import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolveActor } from '../../src/cli/lib/actor.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('resolveActor', () => {
  it('trims explicit actors without invoking a subprocess', () => {
    expect(resolveActor('  $(not-a-command)  ')).toBe('$(not-a-command)');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])('uses trimmed Git identity for an empty flag %s', (flag) => {
    vi.mocked(execFileSync).mockReturnValue('  Git User\n');
    vi.stubEnv('USER', 'environment-user');
    expect(resolveActor(flag)).toBe('Git User');
    expect(execFileSync).toHaveBeenCalledWith('git', ['config', 'user.name'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it.each([
    { user: 'user', logname: 'login', expected: 'user' },
    { user: '', logname: 'login', expected: 'login' },
    { user: undefined, logname: undefined, expected: 'unknown' },
    { user: '  user  ', logname: 'login', expected: '  user  ' },
  ])('preserves environment fallback semantics: $expected', ({ user, logname, expected }) => {
    vi.stubEnv('USER', user);
    vi.stubEnv('LOGNAME', logname);
    vi.mocked(execFileSync).mockReturnValue(' \n');
    expect(resolveActor(undefined)).toBe(expected);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Git unavailable'); });
    expect(resolveActor(undefined)).toBe(expected);
  });
});
