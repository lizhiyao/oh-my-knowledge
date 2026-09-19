interface RunSession {
  dispose(): void | Promise<void>;
}

/** 每个运行内按身份惰性打开资源；拒绝的打开也保留在清理队列中。 */
export class RunResourceSessions<Input, Session extends RunSession> {
  readonly #sessions = new Map<string, Promise<Session>>();
  readonly #keyFor: (input: Input) => string;
  readonly #open: (input: Input) => Session | Promise<Session>;
  #disposal: Promise<number> | undefined;

  constructor(keyFor: (input: Input) => string, open: (input: Input) => Session | Promise<Session>) {
    this.#keyFor = keyFor;
    this.#open = open;
  }

  get(input: Input): Promise<Session> {
    if (this.#disposal !== undefined) throw new TypeError('Run resources are already disposed.');
    const key = this.#keyFor(input);
    const current = this.#sessions.get(key);
    if (current !== undefined) return current;
    const session = Promise.resolve(this.#open(input));
    this.#sessions.set(key, session);
    return session;
  }

  /** 尽力清理所有资源并返回失败数；阶段边界负责映射成自身的错误契约。 */
  dispose(): Promise<number> {
    this.#disposal ??= this.#disposeAll();
    return this.#disposal;
  }

  async #disposeAll(): Promise<number> {
    let failures = 0;
    for (const session of this.#sessions.values()) {
      try { await (await session).dispose(); } catch { failures += 1; }
    }
    return failures;
  }
}
