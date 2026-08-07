export interface TrajectoryLiveLabels {
  connecting: string;
  live: string;
  syncing: string;
  reconnecting: string;
  failed: string;
  following: string;
  resume: string;
  pending: string;
  completed: string;
  aborted: string;
  interrupted: string;
  unknown: string;
  pauseTitle: string;
}

export interface TrajectoryLiveClientOptions {
  shell: HTMLElement;
  timeline: HTMLElement | null;
  liveState: HTMLElement | null;
  followButton: HTMLButtonElement | null;
  followLabel: HTMLElement | null;
  liveEndpoint: string;
  labels: TrajectoryLiveLabels;
  getMode: () => string;
  setMode: (mode: string) => void;
  isScrollTrackingSuppressed?: () => boolean;
  refreshSnapshot?: (state: TrajectoryLiveViewState) => Promise<void>;
  browserWindow: Window;
  browserDocument: Document;
}

export interface TrajectoryLiveViewState {
  mode: string;
  scrollLeft: number;
  followLatest: boolean;
  animateToLatest?: boolean;
}

export interface TrajectoryLiveController {
  pauseFollowing: () => void;
  dispose: () => void;
}

export function createTrajectoryLiveController(options: TrajectoryLiveClientOptions): TrajectoryLiveController {
  const {
    shell,
    timeline,
    liveState,
    followButton,
    followLabel,
    liveEndpoint,
    labels,
    browserWindow,
    browserDocument,
  } = options;
  const stateKey = `omk:live-trajectory:${browserWindow.location.pathname}`;
  const lifecycle = new AbortController();
  let followLatest = Boolean(liveEndpoint);
  let pendingRevision = '';
  let terminalState: 'completed' | 'aborted' | 'interrupted' | 'unknown' | undefined;
  let refreshTimer: number | undefined;
  let scrollReleaseTimer: number | undefined;
  let suppressScrollTracking = false;
  let liveSource: EventSource | undefined;

  const setConnectionState = (state: string, label: string): void => {
    if (!liveState) return;
    liveState.dataset.state = state;
    liveState.textContent = label;
  };
  const isNearLatest = (): boolean => {
    if (!timeline) return true;
    const remaining = timeline.scrollWidth - timeline.clientWidth - timeline.scrollLeft;
    return remaining <= 72;
  };
  const scrollToLatest = (smooth = false): void => {
    if (!timeline || options.getMode() !== 'semantic') return;
    suppressScrollTracking = true;
    const left = Math.max(0, timeline.scrollWidth - timeline.clientWidth);
    const reduceMotion = browserWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (smooth && !reduceMotion && typeof timeline.scrollTo === 'function') {
      timeline.scrollTo({ left, behavior: 'smooth' });
      if (scrollReleaseTimer !== undefined) browserWindow.clearTimeout(scrollReleaseTimer);
      scrollReleaseTimer = browserWindow.setTimeout(() => {
        timeline.scrollLeft = left;
        suppressScrollTracking = false;
        scrollReleaseTimer = undefined;
      }, 700);
    } else {
      timeline.scrollLeft = left;
      browserWindow.requestAnimationFrame(() => { suppressScrollTracking = false; });
    }
  };
  const updateFollowControl = (): void => {
    if (!followButton || !followLabel) return;
    const state = terminalState ?? (!followLatest && pendingRevision
      ? 'pending'
      : (followLatest ? 'following' : 'paused'));
    const terminalLabel = terminalState ? labels[terminalState] : undefined;
    followButton.dataset.state = state;
    followButton.dataset.following = String(followLatest);
    followButton.setAttribute('aria-pressed', String(followLatest));
    followLabel.textContent = terminalLabel ?? (state === 'pending'
        ? labels.pending
        : state === 'following'
          ? labels.following
          : labels.resume);
    followButton.title = state === 'following' ? labels.pauseTitle : followLabel.textContent;
  };
  const setFollowing = (next: boolean, shouldScroll = next): void => {
    if (!next && refreshTimer !== undefined) {
      browserWindow.clearTimeout(refreshTimer);
      refreshTimer = undefined;
      setConnectionState('live', labels.live);
    }
    followLatest = next;
    updateFollowControl();
    if (shouldScroll) scrollToLatest(true);
  };
  const readViewState = (): Partial<TrajectoryLiveViewState> | undefined => {
    try {
      const raw = browserWindow.sessionStorage.getItem(stateKey);
      browserWindow.sessionStorage.removeItem(stateKey);
      return raw ? JSON.parse(raw) as Partial<TrajectoryLiveViewState> : undefined;
    } catch {
      return undefined;
    }
  };
  const currentViewState = (animateToLatest = false): TrajectoryLiveViewState => ({
    mode: options.getMode(),
    scrollLeft: timeline?.scrollLeft ?? 0,
    followLatest,
    ...(animateToLatest ? { animateToLatest: true } : {}),
  });
  const saveViewState = (state = currentViewState()): void => {
    try {
      browserWindow.sessionStorage.setItem(stateKey, JSON.stringify(state));
    } catch {
      // Storage can be unavailable in hardened browsers.
    }
  };
  const restoreViewState = (): void => {
    const state = readViewState();
    if (state?.mode && ['semantic', 'normalized', 'source'].includes(state.mode)) options.setMode(state.mode);
    if (typeof state?.followLatest === 'boolean') followLatest = state.followLatest;
    if (!liveEndpoint || options.getMode() !== 'semantic') followLatest = false;
    updateFollowControl();
    if (timeline && Number.isFinite(state?.scrollLeft)) {
      // Browsers can dispatch this assignment's scroll event after listeners are attached below.
      // Keep restoration programmatic until the final frame settles so it cannot pause live follow.
      suppressScrollTracking = true;
      timeline.scrollLeft = Math.min(state?.scrollLeft ?? 0, Math.max(0, timeline.scrollWidth - timeline.clientWidth));
    }
    browserWindow.requestAnimationFrame(() => {
      browserWindow.requestAnimationFrame(() => {
        if (followLatest && liveEndpoint) scrollToLatest(Boolean(state?.animateToLatest));
        else if (timeline && Number.isFinite(state?.scrollLeft)) {
          timeline.scrollLeft = state?.scrollLeft ?? 0;
          browserWindow.requestAnimationFrame(() => { suppressScrollTracking = false; });
        } else {
          suppressScrollTracking = false;
        }
      });
    });
  };
  const reloadNow = async (): Promise<void> => {
    if (!pendingRevision) return;
    if (refreshTimer !== undefined) browserWindow.clearTimeout(refreshTimer);
    if (scrollReleaseTimer !== undefined) browserWindow.clearTimeout(scrollReleaseTimer);
    refreshTimer = undefined;
    scrollReleaseTimer = undefined;
    setConnectionState('syncing', labels.syncing);
    const viewState = currentViewState(followLatest);
    saveViewState(viewState);
    if (options.refreshSnapshot) {
      const revision = pendingRevision;
      pendingRevision = '';
      updateFollowControl();
      try {
        await options.refreshSnapshot(viewState);
      } catch {
        pendingRevision = revision;
        setConnectionState('reconnecting', labels.reconnecting);
        updateFollowControl();
      }
      return;
    }
    browserWindow.location.reload();
  };
  const applyPendingUpdate = (): void => {
    updateFollowControl();
    if (!pendingRevision
      || !followLatest
      || options.getMode() !== 'semantic'
      || browserDocument.hidden
      || refreshTimer !== undefined) return;
    setConnectionState('syncing', labels.syncing);
    refreshTimer = browserWindow.setTimeout(() => { void reloadNow(); }, 600);
  };
  const pauseFollowing = (): void => {
    if (!liveEndpoint || !followLatest) return;
    setFollowing(false, false);
  };
  const dispose = (): void => {
    lifecycle.abort();
    liveSource?.close();
    if (refreshTimer !== undefined) browserWindow.clearTimeout(refreshTimer);
    if (scrollReleaseTimer !== undefined) browserWindow.clearTimeout(scrollReleaseTimer);
    refreshTimer = undefined;
    scrollReleaseTimer = undefined;
  };

  restoreViewState();
  timeline?.addEventListener('scroll', () => {
    if (suppressScrollTracking
      || options.isScrollTrackingSuppressed?.()
      || !followLatest
      || options.getMode() !== 'semantic') return;
    if (!isNearLatest()) pauseFollowing();
  }, { passive: true, signal: lifecycle.signal });
  followButton?.addEventListener('click', () => {
    if (pendingRevision && !followLatest) {
      setFollowing(true, false);
      void reloadNow();
      return;
    }
    setFollowing(!followLatest);
  }, { signal: lifecycle.signal });
  browserDocument.addEventListener('visibilitychange', () => {
    if (!browserDocument.hidden) applyPendingUpdate();
  }, { signal: lifecycle.signal });
  browserWindow.addEventListener('pagehide', dispose, { once: true, signal: lifecycle.signal });

  const EventSourceConstructor = (browserWindow as Window & { EventSource?: typeof EventSource }).EventSource;
  if (liveEndpoint && EventSourceConstructor) {
    setConnectionState('connecting', labels.connecting);
    const source = new EventSourceConstructor(liveEndpoint);
    liveSource = source;
    source.addEventListener('open', () => setConnectionState('live', labels.live), { signal: lifecycle.signal });
    source.addEventListener('trajectory', (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as {
          revision?: string;
          status?: string;
          liveObservable?: boolean;
        };
        const explicitTerminal = update.status === 'completed'
          || update.status === 'aborted'
          || update.status === 'interrupted';
        const streamTerminal = update.liveObservable === false || explicitTerminal;
        terminalState = explicitTerminal
          ? update.status as 'completed' | 'aborted' | 'interrupted'
          : update.liveObservable === false ? 'unknown' : undefined;
        if (streamTerminal) {
          source.close();
          if (liveSource === source) liveSource = undefined;
        }
        if (!update.revision || update.revision === shell.dataset.liveRevision) {
          const quiet = update.status === 'unknown';
          const connectionLabel = terminalState
            ? labels[terminalState]
            : quiet ? labels.reconnecting : labels.live;
          setConnectionState(
            terminalState ?? (quiet ? 'reconnecting' : 'live'),
            connectionLabel,
          );
          updateFollowControl();
          return;
        }
        pendingRevision = update.revision;
        applyPendingUpdate();
      } catch {
        // Ignore malformed live events and wait for the next revision.
      }
    }, { signal: lifecycle.signal });
    source.addEventListener('trajectory-error', () => {
      source.close();
      if (liveSource === source) liveSource = undefined;
      setConnectionState('failed', labels.failed);
    }, { signal: lifecycle.signal });
    source.addEventListener('error', () => {
      if (!pendingRevision) setConnectionState('reconnecting', labels.reconnecting);
    }, { signal: lifecycle.signal });
  }

  return { pauseFollowing, dispose };
}

export function renderTrajectoryLiveClientSource(): string {
  // Studio 页面没有独立客户端打包链路；序列化已类型检查的控制器，避免维护第二份浏览器实现。
  return createTrajectoryLiveController.toString();
}
