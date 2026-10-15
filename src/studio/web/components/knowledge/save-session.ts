import { useEffect, useMemo, useSyncExternalStore } from 'react';

type SaveState<Command> =
  | { phase: 'editing'; error: string }
  | { phase: 'saving' | 'unknown' | 'checking' | 'saved'; command: Command; error: string };

/** One editor's write and acknowledgement lifecycle; matching remains with its caller. */
export class KnowledgeSaveSession<Command> {
  private state: SaveState<Command> = { phase: 'editing', error: '' };
  private active?: AbortController;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SaveState<Command>) { this.state = state; for (const listener of this.listeners) listener(); }
  clearError() { if (this.state.phase === 'editing' && !this.active) this.publish({ phase: 'editing', error: '' }); }
  cancel() {
    this.active?.abort(); this.active = undefined;
    this.publish({ phase: 'editing', error: '' });
  }
  async save<Value>(command: Command, execute: (command: Command, signal: AbortSignal) => Promise<Value>,
    rejection: (cause: unknown) => string | undefined, unknownMessage: string): Promise<{ value: Value; current(): boolean } | undefined> {
    if (this.active || this.state.phase !== 'editing') return;
    return this.run(command, 'saving', execute, () => true, rejection, unknownMessage);
  }
  async inspect<Value>(execute: (command: Command, signal: AbortSignal) => Promise<Value>,
    matches: (value: Value, command: Command) => boolean, missingMessage: string, failureMessage: string): Promise<{ value: Value; current(): boolean } | undefined> {
    if (this.active || this.state.phase !== 'unknown') return;
    return this.run(this.state.command, 'checking', execute, matches, () => undefined, failureMessage, missingMessage);
  }
  private async run<Value>(command: Command, phase: 'saving' | 'checking',
    execute: (command: Command, signal: AbortSignal) => Promise<Value>, matches: (value: Value, command: Command) => boolean,
    rejection: (cause: unknown) => string | undefined, failureMessage: string, missingMessage = failureMessage) {
    const active = new AbortController(); this.active = active;
    this.publish({ phase, command, error: '' });
    try {
      const value = await execute(command, active.signal);
      if (this.active !== active || active.signal.aborted) return;
      if (!matches(value, command)) { this.publish({ phase: 'unknown', command, error: missingMessage }); return; }
      const saved = { phase: 'saved', command, error: '' } as const;
      this.publish(saved);
      return { value, current: () => !active.signal.aborted && this.state === saved };
    } catch (cause) {
      if (this.active !== active || active.signal.aborted) return;
      const error = rejection(cause);
      this.publish(error ? { phase: 'editing', error } : { phase: 'unknown', command, error: failureMessage });
    } finally { if (this.active === active) this.active = undefined; }
  }
}

export function useKnowledgeSave<Command>(workspace: string) {
  const session = useMemo(() => new KnowledgeSaveSession<Command>(), [workspace]);
  useEffect(() => () => session.cancel(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { session, state, busy: state.phase === 'saving' || state.phase === 'checking' || state.phase === 'saved',
    uncertain: state.phase === 'unknown' || state.phase === 'checking' };
}
