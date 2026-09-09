import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { buildObservationInboxReport, saveObservationInboxReport } from '../../../src/observability/inbox/index.js';
import { buildObservationInboxViewModel } from '../../../src/observability/inbox/view-model.js';
import { renderObservationInboxPage } from '../../../src/studio/presentation/observation-inbox-renderer.js';
import { jsString } from '../../../src/studio/presentation/layout.js';
import { observationInboxClientScript } from '../../../src/studio/presentation/observation-inbox/client-script.js';

function decodeAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => entities[entity]);
}
const attack = "audit'); injected(); //\\\" & <tag>\n";

describe('Inbox event data remains data', () => {
  it('round-trips JavaScript arguments through HTML attribute decoding', () => {
    let received = '';
    runInNewContext(`receive(${decodeAttribute(jsString(attack))})`, { receive: (value: string) => { received = value; }, injected: () => assert.fail('injected script executed') });
    assert.equal(received, attack);
  });

  it.each([attack, 'constructor', 'toString', '__proto__'])('keeps the rendered knowledge name as data: %s', (name) => {
    const root = mkdtempSync(join(tmpdir(), 'omk-inbox-event-'));
    try {
      const report = buildObservationInboxReport(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url).pathname);
      saveObservationInboxReport(report, root);
      const model = buildObservationInboxViewModel(root);
      const experience = model.effectiveExperienceReports[0];
      assert.ok(experience?.skills.length);
      const oldName = experience.skills[0].skillName;
      // Change the value across related DTOs so the rendered card retains its normal session wiring.
      const transform = (value: unknown): unknown => {
        if (value === oldName) return name;
        if (Array.isArray(value)) return value.map(transform);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === oldName ? name : key, transform(item)]));
        return value;
      };
      const html = renderObservationInboxPage(transform(model) as typeof model);
      const encoded = html.match(/onclick="(selectInboxCard\([^\"]+)"/)?.[1];
      assert.ok(encoded);
      let received = '';
      runInNewContext(decodeAttribute(encoded), { selectInboxCard: (value: string) => { received = value; }, injected: () => assert.fail('injected script executed') });
      assert.equal(received, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('matches special attribute values without constructing a CSS selector from them', () => {
    const source = observationInboxClientScript('zh');
    const helpers = source.slice(0, source.indexOf('var observeSeverityFilter'));
    const expected = { getAttribute: () => attack };
    const context = { document: { querySelectorAll: (selector: string) => {
      assert.equal(selector, '[data-inbox-card]');
      return [expected, { getAttribute: () => 'other' }];
    } }, found: undefined as unknown };
    runInNewContext(`${helpers}\nfound = inboxElementByAttribute('data-inbox-card', ${JSON.stringify(attack)});`, context);
    assert.equal(context.found, expected);
  });
});
