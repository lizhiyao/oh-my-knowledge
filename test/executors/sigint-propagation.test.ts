import { describe, it, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  spawnWithSigintPropagation,
  __resetSigintRegistryForTest,
  registerSigintSubscriber,
  type SpawnHelperError,
} from '../../src/executors/core/subprocess.js';

// SIGINT 传播 helper 测试。直接 spawn 真子进程(node -e "...")替代 vi.mock,
// 因为 spawn / ChildProcess / EventEmitter 跟 'exit' / 'close' / 'error' / signal
// 行为细节非常多,mock 很容易失真。子进程都是短命 node 脚本,跑得很快(<200ms)。
//
// 关键 invariant:
// 1. SIGINT propagate:parent 收到 SIGINT 时 child 收到 SIGTERM,500ms 后 SIGKILL
// 2. listener 单一性:进程只装 1 个 SIGINT listener,不论 spawn 多少次
// 3. timeout 路径:跟 SIGINT 路径独立,killedByTimeout=true
// 4. abort 路径:跟 SIGINT 共用 grace,killedBySignal='SIGTERM'
// 5. 自然退出:registry 清空,grace timer 不误触发

describe('spawnWithSigintPropagation', () => {
  beforeEach(() => {
    __resetSigintRegistryForTest();
  });

  it('正常退出 0:resolve with stdout', async () => {
    const { done } = spawnWithSigintPropagation('node', ['-e', 'console.log("hello")']);
    const r = await done;
    assert.equal(r.code, 0);
    assert.equal(r.killedByTimeout, false);
    assert.equal(r.killedBySignal, null);
    assert.match(r.stdout, /hello/);
  });

  it('exit code 非 0:reject 同时透传 stdout/stderr', async () => {
    const { done } = spawnWithSigintPropagation('node', ['-e', 'console.log("out"); console.error("err"); process.exit(2)']);
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.equal(err.code, 2);
      assert.match(err.stdout || '', /out/);
      assert.match(err.stderr || '', /err/);
      return true;
    });
  });

  it('timeout:杀 child 并 reject killedByTimeout=true', async () => {
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'setInterval(()=>{}, 1000)'],
      { timeoutMs: 100 },
    );
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.equal(err.killedByTimeout, true);
      assert.match(err.message, /timed out/);
      return true;
    });
  });

  it('listener 单一性:多次 spawn 仍只 1 个 SIGINT listener', async () => {
    const before = process.listenerCount('SIGINT');
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      const { done } = spawnWithSigintPropagation('node', ['-e', `console.log(${i})`]);
      tasks.push(done);
    }
    await Promise.all(tasks);
    const after = process.listenerCount('SIGINT');
    // 安装一次后不会重复加
    assert.ok(after - before <= 1, `listener leaked: before=${before}, after=${after}`);
  });

  it('SDK subscriber 与 child 共用唯一 coordinator，重发 SIGINT 前先统一 abort', async () => {
    const existing = new Set(process.listeners('SIGINT'));
    let abortCount = 0;
    const unregisterA = registerSigintSubscriber(() => { abortCount += 1; });
    const unregisterB = registerSigintSubscriber(() => { abortCount += 1; });
    const installed = process.listeners('SIGINT').filter((listener) => !existing.has(listener));
    assert.equal(installed.length, 1);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      installed[0]('SIGINT');
      assert.equal(abortCount, 2);
      assert.equal(kill.mock.calls.some(([pid, signal]) => pid === process.pid && signal === 'SIGINT'), true);
      assert.equal(process.listeners('SIGINT').includes(installed[0]), false);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      unregisterA();
      unregisterB();
      kill.mockRestore();
    }
  });

  it('child 自然退出:registry 立即清空,grace timer 不误升级 SIGKILL', async () => {
    const { child, done } = spawnWithSigintPropagation('node', ['-e', 'process.exit(0)']);
    await done;
    // 退出后 child.killed 应为 false(因为是自己退出,不是被 kill)
    // 关键 invariant:done 已经 settle,后续没有 timer 会再触发 child.kill
    // 用 setTimeout 等 SIGTERM_GRACE_MS+50 验证没有事件抛出
    await new Promise((res) => setTimeout(res, 600));
    assert.ok(child.killed === false || child.exitCode !== null, 'child 应该自然退出');
  });

  it('abortSignal:abort() 触发 SIGTERM,killedBySignal=SIGTERM', async () => {
    const ac = new AbortController();
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'setInterval(()=>{}, 1000)'],
      { abortSignal: ac.signal, timeoutMs: 5000 },
    );
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.equal(err.killedByTimeout, false);
      assert.equal(err.killedBySignal, 'SIGTERM');
      return true;
    });
  });

  it('already-aborted signal cancels the child immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'setInterval(()=>{}, 1000)'],
      { abortSignal: ac.signal, timeoutMs: 5000 },
    );
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.equal(err.killedByTimeout, false);
      assert.equal(err.killedBySignal, 'SIGTERM');
      assert.ok(Date.now() - start < 1500);
      return true;
    });
  });

  it('maxBuffer:stdout 超限时 reject + kill', async () => {
    // 写 200KB 到 stdout,maxBuffer 设 10KB
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'process.stdout.write("x".repeat(200000))'],
      { maxBuffer: 10 * 1024 },
    );
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.match(err.message, /stdout maxBuffer/);
      return true;
    });
  });

  it('maxBuffer:stderr 超限时也 reject + kill', async () => {
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'process.stderr.write("x".repeat(200000))'],
      { maxBuffer: 10 * 1024 },
    );
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.match(err.message, /stderr maxBuffer/);
      return true;
    });
  });

  it('stdout/stderr 分别捕获', async () => {
    const { done } = spawnWithSigintPropagation('node', ['-e', 'console.log("o"); console.error("e")']);
    const r = await done;
    assert.match(r.stdout, /o/);
    assert.match(r.stderr, /e/);
  });

  it('child 收到 SIGTERM 后立即处理 SIGKILL fallback(grace 后)', async () => {
    // node 子进程默认收到 SIGTERM 会立即退出,所以 grace 计时器一般不会真触发
    // 这里写一个 ignore SIGTERM 的脚本验证 SIGKILL 兜底
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'],
      { timeoutMs: 100 },
    );
    const start = Date.now();
    await assert.rejects(done, (err: SpawnHelperError) => {
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1500, `SIGKILL fallback should kick in within ~600ms grace, got ${elapsed}ms`);
      assert.equal(err.killedByTimeout, true);
      return true;
    });
  });

  it('timeout remains authoritative when child traps SIGTERM and exits 0', async () => {
    vi.useFakeTimers();
    try {
      const { child, done } = spawnWithSigintPropagation(
        'node',
        [
          '-e',
          // 先发 readiness，确保 parent 触发 timeout 前 SIGTERM handler 已安装。
          // handler 写完 stdout 后 exit 0，模拟 codex／claude binary 的 telemetry flush。
          'process.on("SIGTERM",()=>{process.stdout.write("done");process.exit(0)}); process.stdout.write("ready\\n"); setInterval(()=>{},1000)',
        ],
        { timeoutMs: 100 },
      );
      const rejected = assert.rejects(done, (err: SpawnHelperError) => {
        assert.equal(err.code, 0);
        assert.equal(err.stdout, 'ready\ndone');
        assert.equal(err.killedByTimeout, true);
        assert.match(err.message, /timed out/);
        return true;
      });

      await new Promise<void>((resolve) => {
        child.stdout?.once('data', () => resolve());
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  // UltraReview Item 7:bufferOverflow 路径要走 graceTimer,不能裸 SIGTERM。
  // child trap SIGTERM 不退出时,旧实现会让 child 永不被 SIGKILL,变成 zombie。
  it('bufferOverflow + child trap SIGTERM:500ms 内被 SIGKILL 兜底', async () => {
    // child 先疯狂写 stdout 触发 bufferOverflow,然后 trap SIGTERM 不退
    const { done } = spawnWithSigintPropagation(
      'node',
      [
        '-e',
        'process.on("SIGTERM",()=>{}); const buf="x".repeat(100000); for(let i=0;i<5;i++){process.stdout.write(buf)} setInterval(()=>{},1000)',
      ],
      { maxBuffer: 10 * 1024 },
    );
    const start = Date.now();
    await assert.rejects(done, (err: SpawnHelperError) => {
      const elapsed = Date.now() - start;
      assert.match(err.message, /maxBuffer/);
      assert.ok(elapsed < 1500, `bufferOverflow SIGKILL fallback should kick in within ~600ms, got ${elapsed}ms`);
      return true;
    });
  });
});
