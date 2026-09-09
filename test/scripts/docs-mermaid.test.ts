import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: calls }));

import { renderDiagram } from '../../docs/.vitepress/theme/mermaid-renderer.js';

describe('documentation Mermaid renderer', () => {
  it('serializes theme configuration until the preceding diagram finishes', async () => {
    let finish!: (value: { svg: string }) => void;
    const firstRender = new Promise<{ svg: string }>((resolve) => { finish = resolve; });
    calls.render.mockImplementationOnce(() => firstRender)
      .mockResolvedValueOnce({ svg: '<svg>light</svg>' });
    const dark = renderDiagram('graph TD; A-->B', true);
    const light = renderDiagram('graph TD; C-->D', false);
    await vi.waitFor(() => expect(calls.render).toHaveBeenCalledTimes(1));
    expect(calls.initialize).toHaveBeenCalledTimes(1);
    expect(calls.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: 'dark', securityLevel: 'strict', htmlLabels: false,
    }));
    finish({ svg: '<svg>dark</svg>' });
    expect(await dark).toBe('<svg>dark</svg>');
    expect(await light).toBe('<svg>light</svg>');
    expect(calls.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
    expect(calls.render.mock.calls[0][0]).not.toBe(calls.render.mock.calls[1][0]);
  });

  it('does not let a malformed diagram block subsequent diagrams', async () => {
    calls.render.mockRejectedValueOnce(new Error('invalid diagram'))
      .mockResolvedValueOnce({ svg: '<svg>valid</svg>' });
    await expect(renderDiagram('invalid', false)).rejects.toThrow('invalid diagram');
    await expect(renderDiagram('graph TD; A-->B', false)).resolves.toBe('<svg>valid</svg>');
  });
});
