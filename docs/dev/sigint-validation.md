# SIGINT propagation 手动验证

本文档记录在 nested CLI host 场景(host=codex 或 claude code,内层 omk + spawn child)下,
Ctrl+C 传播是否把内层子进程也 kill 干净的手动验证流程。CI 不跑(timing flake + 需要真
binary auth)。

## 验证目标

- 用户按 Ctrl+C 时:host process 退出 → omk 退出 → 内层 codex / claude binary **立即退出**(SIGTERM,500ms grace 后 SIGKILL)
- 修复前(基线):内层 child 继续跑直到 timeout(30-180s),变成 orphan
- 修复后:内层 child 几百毫秒内消失

## 准备

```bash
# 1. 切到 fix 分支并 build
git checkout fix/sigint-propagation
yarn build

# 2. 准备一个会跑较长时间的 sample 文件
cat > /tmp/sigint-long.json <<'EOF'
[
  {"sample_id":"long-1","prompt":"详细写一个 500 字的 Python 装饰器教程,包含至少 3 个示例","rubric":"覆盖 @decorator 基本用法、参数装饰器、类装饰器"},
  {"sample_id":"long-2","prompt":"详细写一个 500 字的 React useEffect 教程","rubric":"覆盖依赖数组、cleanup、常见陷阱"}
]
EOF
```

## 验证步骤

### 终端 A:跑长 eval

```bash
cd /path/to/oh-my-knowledge
node dist/cli/index.js omk eval \
  --samples /tmp/sigint-long.json \
  --control baseline \
  --executor codex --model gpt-5.5 \
  --no-judge --no-strict-baseline --no-serve --skip-preflight \
  --concurrency 2 --timeout 180 \
  --verbose
# 等到看见 "[1/2] long-1/baseline ⏳ 执行中..." 出现后,按 Ctrl+C
```

### 终端 B:观察 child 进程

```bash
# 在终端 A 按 Ctrl+C 之前
ps -ef | grep -E '(omk|codex|node.*eval)' | grep -v grep
# 应该看到:
#   1. parent omk node 进程
#   2. 一到两个 codex 子进程(spawn 出来的)

# 终端 A 按 Ctrl+C 之后立即(<1s)再跑
ps -ef | grep -E '(omk|codex|node.*eval)' | grep -v grep
# 期望:omk + codex 子进程都已消失
# 修复前(基线):omk 退了但 codex 还在跑(orphan,parent PID 变 1)
```

## 通过标准

- 终端 A:Ctrl+C 后 1s 内回到 shell prompt
- 终端 B:Ctrl+C 后 1s 内 `ps -ef | grep codex` 找不到 codex orphan 进程
- 不限于 codex:换 `--executor claude-sdk`(in-process,无 child)/ `--executor claude` / `--executor gemini` / `--executor "<custom-script>"` 都应表现一致(后三者有 child,前者无)

## 嵌套 host 验证(可选,需要 host CLI auth)

```bash
# host = codex CLI
codex
# 在 codex 里:运行 shell tool: omk eval --executor codex ...(同上面的命令)
# 在 codex 里按 Ctrl+C
# 退出 codex 后回到 shell,跑 ps -ef | grep codex,期望:0 个 orphan
```

```bash
# host = claude code
claude
# 在 claude code 里:Bash tool 运行 omk eval ...
# 按 Ctrl+C 中断
# 同样验证:无 codex / claude binary orphan
```

## 已知 limitations

- **Windows**:Node 的 `child.kill('SIGTERM')` 在 Windows 上是 `TerminateProcess` 等价 SIGKILL,**没有 grace period**。omk 主战场是 macOS / Linux,Windows best-effort。
- **`--export` / dev mode**:`cli/index.ts` 的 dev mode `node --watch` spawn 不走 executor 路径,SIGINT 传播由 dev mode 自己处理。本 fix 不影响。
- **HTTP executor**(`anthropic-api` / `openai-api`):用 fetch + `AbortSignal.timeout`,自带 abort,无 child 进程,无 orphan 风险。本 fix 不动它们。

## codex-sdk executor 的额外校验

`@openai/codex-sdk` 内部自己 `spawn(executablePath, ...)`,SDK 子进程**不在** `spawnWithSigintPropagation` 维护的 registry 里。`codex-sdk` executor 因此自己 install 一个 SIGINT listener 调 `abortController.abort()`,SDK 拿到 abort 后用它注册到 `spawn` 的 `signal` 选项 SIGTERM 子进程。

验证方式:把上面"终端 A"命令的 `--executor codex` 换成 `--executor codex-sdk`,Ctrl+C 后预期同样无 orphan。listener 的 install/remove 走 try/finally,validation 抛错时不会装 listener。
