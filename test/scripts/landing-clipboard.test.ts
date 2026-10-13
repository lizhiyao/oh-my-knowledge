import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyCommand } from '../../docs/.vitepress/theme/landing-init.js';

function browser(copy: () => boolean) {
  const remove = vi.fn();
  const focus = vi.fn();
  class Element { focus = focus; }
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', {
    activeElement: new Element(),
    createElement: () => ({ style: {}, focus: vi.fn(), select: vi.fn(), remove }),
    body: { appendChild: vi.fn() },
    execCommand: copy,
  });
  return { remove, focus };
}

afterEach(() => vi.unstubAllGlobals());

describe('website command copy', () => {
  it('reports success only after the clipboard write resolves', async () => {
    const fallback = vi.fn(() => false);
    browser(fallback);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyCommand('omk studio')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('omk studio');
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses the actual fallback result after permission rejection: %s', async result => {
    const fallback = vi.fn(() => result);
    const { remove, focus } = browser(fallback);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    expect(await copyCommand('omk studio')).toBe(result);
    expect(remove).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('restores focus and removes the temporary field when the fallback throws', async () => {
    const { remove, focus } = browser(() => { throw new Error('unavailable'); });
    expect(await copyCommand('omk studio')).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
});
