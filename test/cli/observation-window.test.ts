import { describe, expect, it } from 'vitest';
import { resolveObservationWindow } from '../../src/cli/lib/observation-window.js';

describe('observation time window', () => {
  it.each([
    { from: 'not-a-date' },
    { from: '2026-02-30T00:00:00Z' },
    { to: '2026-09-10T12:00:00' },
    { from: '' },
    { last: '999999999999999999999d' },
    { last: '0h' },
    { last: '-1m' },
    { from: '2026-09-11T00:00:00Z', to: '2026-09-10T00:00:00Z' },
  ])('rejects invalid input before query: %j', (input) => {
    expect(() => resolveObservationWindow(input, 'en')).toThrow(expect.objectContaining({ oclif: { exit: 2 } }));
  });

  it('compares instants across timezones and accepts equal boundaries', () => {
    const input = { from: '2026-09-11T08:00:00+08:00', to: '2026-09-11T00:00:00Z' };
    expect(resolveObservationWindow(input, 'en')).toEqual(input);
  });

  it('uses an explicit clock for relative windows and preserves an explicit start', () => {
    const now = Date.parse('2026-09-11T00:00:00Z');
    expect(resolveObservationWindow({ last: '1d' }, 'en', now).from).toBe('2026-09-10T00:00:00.000Z');
    expect(resolveObservationWindow({ last: '1d', from: '2026-09-09T00:00:00Z' }, 'en', now).from).toBe('2026-09-09T00:00:00Z');
  });
});

it('filters actual trace sessions across timezone offsets and rejects invalid windows before persistence', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { default: Observe } = await import('../../src/cli/commands/observe/index.js');
  const { runCommand } = await import('../helpers/run-command.js');
  const root = mkdtempSync(join(tmpdir(), 'omk-window-query-'));
  try {
    const traces = join(root, 'traces');
    const output = join(root, 'reports');
    mkdirSync(traces);
    for (const day of ['09', '10', '11']) {
      const common = { sessionId: `s${day}`, cwd: root };
      const records = [
        { ...common, type: 'user', uuid: `u${day}`, parentUuid: null, timestamp: `2026-09-${day}T00:00:00Z`, message: { role: 'user', content: `<command-name>/audit${day}</command-name>\nFind schema` } },
        { ...common, type: 'assistant', uuid: `a${day}`, parentUuid: `u${day}`, timestamp: `2026-09-${day}T00:00:01Z`, message: { role: 'assistant', content: [{ type: 'text', text: 'No schema found' }] } },
      ];
      writeFileSync(join(traces, `${day}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n'));
    }
    const options = { cwd: root, env: { OMK_ARTIFACT_INDEX_DIR: join(root, 'index') } };
    await expect(runCommand(Observe, [traces, '--from', 'not-a-date', '--output-dir', output, '--no-feedback'], options))
      .rejects.toMatchObject({ code: 2 });
    expect(existsSync(output)).toBe(false);
    for (const lang of ['zh', 'en']) {
      const rendered = await runCommand(Observe, [traces, '--from', '2026-09-10T08:00:00+08:00', '--to', '2026-09-10T00:00:01Z', '--output-dir', output, '--no-feedback', '--lang', lang], options);
      expect(rendered.stdout).toContain(lang === 'zh' ? '会话: 1' : 'sessions: 1');
      expect(rendered.stdout).toContain('audit10');
      expect(rendered.stdout).not.toContain('audit09');
      expect(rendered.stdout).not.toContain('audit11');
    }
    for (const id of readdirSync(output)) {
      const report = JSON.parse(readFileSync(join(output, id, 'report.json'), 'utf8'));
      expect(report.meta.sessionCount).toBe(1);
      expect(Object.keys(report.bySkill)).toEqual(['audit10']);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
