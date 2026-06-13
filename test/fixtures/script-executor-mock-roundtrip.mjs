// 真实命中 round-trip:模拟底层 Claude Code 兼容 CLI —— 从 OMK_MOCK_SETTINGS_FILE 取出
// PreToolUse hook 命令,喂一个会命中 mock 的工具事件触发它(hook 读 OMK_MOCKS_FILE 匹配、
// 写 hits.json)。这样 script executor 跑完 readStats() 能读回 hits>0、回填 mockStats,
// 验证「env 暴露 → hook 命中记录 → readStats 回填」完整闭环。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
JSON.parse(Buffer.concat(chunks).toString('utf8')); // 消费 stdin 契约

const settings = JSON.parse(readFileSync(process.env.OMK_MOCK_SETTINGS_FILE, 'utf8'));
const hookCmd = settings.hooks.PreToolUse[0].hooks[0].command; // "node /abs/mock-hook.cjs"
const event = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
// hook 进程继承本进程 env(含 OMK_MOCKS_FILE),据此匹配并写 hits.json。
execSync(hookCmd, { input: event, stdio: ['pipe', 'pipe', 'pipe'] });

process.stdout.write(JSON.stringify({ output: 'roundtrip-done' }));
