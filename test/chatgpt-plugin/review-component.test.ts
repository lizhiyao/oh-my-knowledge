import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { observationReviewComponentHtml } from '../../src/chatgpt-plugin/review-component.js';

type EventHandler = (event?: unknown) => unknown;

class FakeElement {
  textContent = '';
  value = '';
  placeholder = '';
  className = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  private readonly listeners = new Map<string, EventHandler[]>();

  constructor(readonly ownerDocument: FakeDocument) {}

  addEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  async dispatch(type: string): Promise<void> {
    await Promise.all((this.listeners.get(type) ?? []).map((handler) => handler({ target: this })));
  }
}

class FakeDocument {
  readonly documentElement = { lang: '' };
  readonly elements = new Map<string, FakeElement>();
  readonly verdictButtons: FakeElement[];
  readonly buttons: FakeElement[];
  activeElement: FakeElement | null = null;

  constructor() {
    const ids = [
      'loading',
      'content',
      'coverage-title',
      'coverage-description',
      'coverage-details-label',
      'unavailable-list',
      'eyebrow',
      'skill-name',
      'observation-meta',
      'occurrences',
      'occurrences-label',
      'evidence-heading',
      'evidence-count',
      'evidence-list',
      'review-heading',
      'current-verdict',
      'note-label',
      'review-note',
      'review-status',
      'draft-panel',
      'draft-heading',
      'draft-description',
      'prompt-label',
      'candidate-prompt',
      'rubric-label',
      'candidate-rubric',
      'draft-button',
      'draft-status',
    ];
    ids.forEach((id) => this.elements.set(id, new FakeElement(this)));
    this.verdictButtons = [
      this.verdictButton('real_issue'),
      this.verdictButton('not_issue'),
      this.verdictButton('needs_more_context'),
    ];
    this.buttons = [...this.verdictButtons, this.getElementById('draft-button')];
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement {
    const element = this.elements.get(id);
    if (!element) throw new Error(`Unknown fake element: ${id}`);
    return element;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '[data-verdict]') return this.verdictButtons;
    if (selector === 'button') return this.buttons;
    return [];
  }

  private verdictButton(verdict: string): FakeElement {
    const button = new FakeElement(this);
    button.dataset.verdict = verdict;
    return button;
  }
}

interface BridgeRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

function createBridgeHarness() {
  const document = new FakeDocument();
  const requests: BridgeRequest[] = [];
  let messageHandler: EventHandler | undefined;
  const parent = {
    postMessage(message: BridgeRequest): void {
      requests.push(message);
    },
  };
  const window = {
    parent,
    openai: undefined,
    addEventListener(type: string, handler: EventHandler): void {
      if (type === 'message') messageHandler = handler;
    },
  };
  const script = extractComponentScript();
  runInNewContext(script, {
    document,
    navigator: { language: 'en' },
    window,
  });

  function send(data: Record<string, unknown>): void {
    if (!messageHandler) throw new Error('Component did not register a message handler.');
    messageHandler({ source: parent, data: { jsonrpc: '2.0', ...data } });
  }

  return {
    document,
    requests,
    notify(structuredContent: Record<string, unknown>): void {
      send({
        method: 'ui/notifications/tool-result',
        params: { structuredContent },
      });
    },
    respond(id: number, result: Record<string, unknown>): void {
      send({ id, result });
    },
  };
}

function extractComponentScript(): string {
  const match = observationReviewComponentHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('Observation review component script is missing.');
  return match[1];
}

function componentState(options: {
  verdict?: 'real_issue' | 'not_issue' | 'needs_more_context';
  note?: string;
} = {}): Record<string, unknown> {
  return {
    observation: {
      observationId: 'observation-1',
      skillName: 'omk',
      artifactVersion: 'v1',
      occurrences: 1,
      captureCoverage: {
        coverageStatus: 'partial',
        unavailableEventKinds: ['full_conversation', 'external_tool_calls', 'hidden_reasoning'],
      },
      evidence: [{
        capturedAt: '2026-08-25T10:00:00.000Z',
        userFeedback: 'The answer missed an important boundary.',
      }],
      ...(options.verdict ? {
        review: {
          verdict: options.verdict,
          reviewedAt: '2026-08-25T10:01:00.000Z',
          note: options.note,
        },
      } : {}),
    },
    actions: { canReview: true, canDraft: true },
    proposal: {
      prompt: 'Explain the observation boundary.',
      rubric: 'Must explain partial coverage.',
    },
  };
}

describe('ChatGPT observation review component bridge', () => {
  it('preserves an existing note and updates from the authoritative review result', async () => {
    const harness = createBridgeHarness();
    harness.notify(componentState({ verdict: 'needs_more_context', note: 'Original note.' }));
    const note = harness.document.getElementById('review-note');
    assert.equal(note.value, 'Original note.');

    note.value = 'Edited note.';
    await note.dispatch('input');
    harness.notify(componentState({ verdict: 'needs_more_context', note: 'Stale server note.' }));
    assert.equal(note.value, 'Edited note.');

    const realIssue = harness.document.verdictButtons[0];
    const action = realIssue?.dispatch('click');
    assert.ok(action);
    assert.equal(harness.requests.length, 1);
    const request = harness.requests[0];
    assert.equal(request?.params.name, 'record_observation_review');
    assert.deepEqual(JSON.parse(JSON.stringify(request?.params.arguments)), {
      observationId: 'observation-1',
      verdict: 'real_issue',
      note: 'Edited note.',
    });
    harness.respond(request?.id ?? 0, {
      structuredContent: {
        observationId: 'observation-1',
        review: {
          verdict: 'real_issue',
          reviewedAt: '2026-08-25T10:02:00.000Z',
          note: 'Edited note.',
        },
      },
    });
    await action;

    assert.equal(harness.requests.length, 1, 'review success must not trigger a second refresh call');
    assert.equal(note.value, 'Edited note.');
    assert.equal(harness.document.getElementById('current-verdict').textContent, 'Real issue');
    assert.equal(harness.document.getElementById('review-status').textContent, 'Review saved.');
  });

  it('surfaces tool-level draft errors instead of reporting success', async () => {
    const harness = createBridgeHarness();
    harness.notify(componentState({ verdict: 'real_issue', note: 'Confirmed.' }));
    const draftButton = harness.document.getElementById('draft-button');
    const action = draftButton.dispatch('click');
    const request = harness.requests[0];
    assert.equal(request?.params.name, 'draft_sample_from_observation');
    harness.respond(request?.id ?? 0, {
      isError: true,
      content: [{ type: 'text', text: 'Draft rejected by the server.' }],
    });
    await action;

    const status = harness.document.getElementById('draft-status');
    assert.equal(status.textContent, 'Draft failed: Draft rejected by the server.');
    assert.equal(status.dataset.tone, 'error');
  });
});
