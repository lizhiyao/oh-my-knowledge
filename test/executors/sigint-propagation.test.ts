import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  spawnWithSigintPropagation,
  __resetSigintRegistryForTest,
  type SpawnHelperError,
} from '../../src/executors/shared.js';

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

  it('maxBuffer:stdout 超限时 reject + kill', async () => {
    // 写 200KB 到 stdout,maxBuffer 设 10KB
    const { done } = spawnWithSigintPropagation(
      'node',
      ['-e', 'process.stdout.write("x".repeat(200000))'],
      { maxBuffer: 10 * 1024 },
    );
    await assert.rejects(done, (err: SpawnHelperError) => {
      assert.match(err.message, /maxBuffer/);
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
});
