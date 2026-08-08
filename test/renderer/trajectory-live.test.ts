import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  createTrajectoryLiveController,
  renderTrajectoryLiveClientSource,
  type TrajectoryLiveLabels,
  type TrajectoryLiveViewState,
} from '../../src/renderer/trajectory-live.js';

const labels: TrajectoryLiveLabels = {
  connecting: '连接中', live: '实时', syncing: '同步中', reconnecting: '重连中',
  failed: '实时更新失败',
  following: '跟随中', resume: '跟随最新', pending: '查看更新', completed: '任务已结束',
  aborted: '任务已中止', interrupted: '任务已中断', unknown: '状态未知',
  pauseTitle: '暂停自动跟随',
};

describe('trajectory live client', () => {
  it('keeps the browser controller executable from the typed source of truth', () => {
    const source = renderTrajectoryLiveClientSource();
    const controller = Function(`${source}; return createTrajectoryLiveController;`)() as unknown;

    assert.equal(typeof controller, 'function');
    assert.match(source, /followLatest/);
    assert.match(source, /sessionStorage/);
    assert.match(source, /location\.reload/);
  });

  it('refreshes the rendered snapshot in place when a new live revision arrives', async () => {
    const scheduled: Array<() => void> = [];
    const stored = new Map<string, string>();
    const sourceListeners = new Map<string, EventListener>();
    let reloadCount = 0;
    let sourceClosed = false;
    let refreshedState: TrajectoryLiveViewState | undefined;

    class FakeEventSource {
      addEventListener(type: string, listener: EventListener): void {
        sourceListeners.set(type, listener);
      }
      close(): void {
        sourceClosed = true;
      }
    }

    const timeline = {
      scrollWidth: 1800,
      clientWidth: 800,
      scrollLeft: 1000,
      addEventListener: () => undefined,
      scrollTo: () => undefined,
    } as unknown as HTMLElement;
    const followButton = {
      dataset: {},
      setAttribute: () => undefined,
      addEventListener: () => undefined,
      title: '',
    } as unknown as HTMLButtonElement;
    const followLabel = { textContent: '' } as HTMLElement;
    const liveState = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    const browserWindow = {
      location: { pathname: '/conversations/thread/tasks/turn', reload: () => { reloadCount += 1; } },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length; },
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false }),
      EventSource: FakeEventSource,
    } as unknown as Window;
    const browserDocument = {
      hidden: false,
      addEventListener: () => undefined,
    } as unknown as Document;

    const controller = createTrajectoryLiveController({
      shell: { dataset: { liveRevision: 'revision-1' } } as unknown as HTMLElement,
      timeline,
      liveState,
      followButton,
      followLabel,
      liveEndpoint: '/live',
      labels,
      getMode: () => 'semantic',
      setMode: () => undefined,
      refreshSnapshot: async (state) => { refreshedState = state; },
      browserWindow,
      browserDocument,
    });

    const trajectoryListener = sourceListeners.get('trajectory');
    assert.ok(trajectoryListener);
    trajectoryListener({ data: JSON.stringify({ revision: 'revision-2', status: 'open' }) } as MessageEvent);
    assert.equal(followLabel.textContent, '跟随中');
    assert.equal(followButton.dataset.state, 'following');
    assert.equal(scheduled.length, 1);
    scheduled[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(reloadCount, 0);
    assert.deepEqual(refreshedState, {
      mode: 'semantic',
      scrollLeft: 1000,
      followLatest: true,
    });
    sourceClosed = false;
    trajectoryListener({ data: JSON.stringify({ status: 'unknown', liveObservable: true }) } as MessageEvent);
    assert.equal(sourceClosed, false);
    assert.equal(liveState.dataset.state, 'reconnecting');
    trajectoryListener({ data: JSON.stringify({ revision: 'revision-3', status: 'completed' }) } as MessageEvent);
    assert.equal(sourceClosed, true);
    controller.dispose();
    assert.equal(sourceClosed, true);
  });

  it('closes the EventSource after a terminal live-update error', () => {
    const sourceListeners = new Map<string, EventListener>();
    let sourceClosed = false;
    class FakeEventSource {
      addEventListener(type: string, listener: EventListener): void {
        sourceListeners.set(type, listener);
      }
      close(): void {
        sourceClosed = true;
      }
    }
    const liveState = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    const browserWindow = {
      location: { pathname: '/conversations/thread/tasks/turn' },
      sessionStorage: { getItem: () => null, removeItem: () => undefined, setItem: () => undefined },
      requestAnimationFrame: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false }),
      EventSource: FakeEventSource,
    } as unknown as Window;
    const controller = createTrajectoryLiveController({
      shell: { dataset: { liveRevision: 'revision-1' } } as unknown as HTMLElement,
      timeline: null,
      liveState,
      followButton: null,
      followLabel: null,
      liveEndpoint: '/live',
      labels,
      getMode: () => 'semantic',
      setMode: () => undefined,
      browserWindow,
      browserDocument: {
        hidden: false,
        addEventListener: () => undefined,
      } as unknown as Document,
    });

    sourceListeners.get('trajectory-error')?.(new Event('trajectory-error'));

    assert.equal(sourceClosed, true);
    assert.equal(liveState.dataset.state, 'failed');
    assert.equal(liveState.textContent, '实时更新失败');
    controller.dispose();
  });

  it('does not pause live follow for layout-driven timeline scrolling', () => {
    const timelineListeners = new Map<string, EventListener>();
    let layoutChanging = true;
    const attributes = new Map<string, string>();
    const timeline = {
      scrollWidth: 1800,
      clientWidth: 800,
      scrollLeft: 1000,
      addEventListener: (type: string, listener: EventListener) => timelineListeners.set(type, listener),
    } as unknown as HTMLElement;
    const followButton = {
      dataset: {},
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      addEventListener: () => undefined,
      title: '',
    } as unknown as HTMLButtonElement;
    const followLabel = { textContent: '' } as HTMLElement;
    const browserWindow = {
      location: { pathname: '/conversations/thread/tasks/turn' },
      sessionStorage: { getItem: () => null, removeItem: () => undefined, setItem: () => undefined },
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false }),
    } as unknown as Window;
    const controller = createTrajectoryLiveController({
      shell: { dataset: {} } as unknown as HTMLElement,
      timeline,
      liveState: null,
      followButton,
      followLabel,
      liveEndpoint: '/live',
      labels,
      getMode: () => 'semantic',
      setMode: () => undefined,
      isScrollTrackingSuppressed: () => layoutChanging,
      browserWindow,
      browserDocument: { hidden: false, addEventListener: () => undefined } as unknown as Document,
    });

    timeline.scrollLeft = 200;
    timelineListeners.get('scroll')?.(new Event('scroll'));
    assert.equal(followLabel.textContent, '跟随中');
    assert.equal(attributes.get('aria-pressed'), 'true');

    layoutChanging = false;
    timelineListeners.get('scroll')?.(new Event('scroll'));
    assert.equal(followLabel.textContent, '跟随最新');
    assert.equal(attributes.get('aria-pressed'), 'false');
    controller.dispose();
  });

  it('keeps unknown evidence distinct when a live task is no longer observable', () => {
    const sourceListeners = new Map<string, EventListener>();
    let sourceClosed = false;
    class FakeEventSource {
      addEventListener(type: string, listener: EventListener): void {
        sourceListeners.set(type, listener);
      }
      close(): void {
        sourceClosed = true;
      }
    }
    const liveState = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    const browserWindow = {
      location: { pathname: '/conversations/thread/tasks/turn' },
      sessionStorage: { getItem: () => null, removeItem: () => undefined, setItem: () => undefined },
      requestAnimationFrame: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      matchMedia: () => ({ matches: false }),
      EventSource: FakeEventSource,
    } as unknown as Window;
    const controller = createTrajectoryLiveController({
      shell: { dataset: { liveRevision: 'revision-1' } } as unknown as HTMLElement,
      timeline: null,
      liveState,
      followButton: null,
      followLabel: null,
      liveEndpoint: '/live',
      labels,
      getMode: () => 'semantic',
      setMode: () => undefined,
      browserWindow,
      browserDocument: {
        hidden: false,
        addEventListener: () => undefined,
      } as unknown as Document,
    });

    sourceListeners.get('trajectory')?.({
      data: JSON.stringify({ status: 'unknown', liveObservable: false }),
    } as MessageEvent);

    assert.equal(sourceClosed, true);
    assert.equal(liveState.dataset.state, 'unknown');
    assert.equal(liveState.textContent, '状态未知');
    controller.dispose();
  });
});
