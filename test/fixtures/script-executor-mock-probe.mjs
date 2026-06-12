// 探针:把 mock 相关的 env 与临时 settings 文件状态塞进 output(唯一会被
// scriptExecutor 透传回来的字段),供测试断言 env 暴露 + 物化 + cleanup。
import { existsSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
JSON.parse(Buffer.concat(chunks).toString('utf8')); // 消费 stdin 契约

const settings = process.env.OMK_MOCK_SETTINGS_FILE || '';
process.stdout.write(JSON.stringify({
  output: JSON.stringify({
    hasSettingsEnv: !!process.env.OMK_MOCK_SETTINGS_FILE,
    hasMocksFile: !!process.env.OMK_MOCKS_FILE,
    settingsPath: settings,
    settingsExists: settings ? existsSync(settings) : false,
  }),
}));
