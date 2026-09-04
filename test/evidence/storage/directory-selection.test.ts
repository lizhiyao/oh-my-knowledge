import { describe, expect, it, vi } from 'vitest';
import { resolveDataDirectory } from '../../../src/evidence/storage/directory-selection.js';

describe('data directory selection', () => {
  it.each([
    { populated: ['/project'], expected: '/project' },
    { populated: ['/global'], expected: '/global' },
    { populated: ['/project', '/global'], expected: '/project' },
    { populated: [], expected: '/project' },
  ])('selects $expected for populated=$populated', ({ populated, expected }) => {
    expect(resolveDataDirectory(
      '/project',
      '/global',
      (directory) => populated.includes(directory),
    )).toBe(expected);
  });

  it('does not probe the same physical fallback directory twice', () => {
    const hasData = vi.fn(() => false);

    expect(resolveDataDirectory('/workspace/data', '/workspace/./data', hasData))
      .toBe('/workspace/data');
    expect(hasData).toHaveBeenCalledTimes(1);
  });
});
