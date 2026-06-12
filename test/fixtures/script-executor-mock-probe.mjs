// 探针:把 mock 相关的 env 与临时 settings 文件状态塞进 output(唯一会被
// scriptExecutor 透传回来的字段),供测试断言 env 暴露 + 物化 + cleanup。
import { existsSync, readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
JSON.parse(Buffer.concat(chunks).toString('utf8')); // 消费 stdin 契约

const settings = process.env.OMK_MOCK_SETTINGS_FILE || '';
// 顺带回传 mocks.json 里的 strict,验证 mocksStrict 透传到物化产物。
let strict = null;
const mocksFile = process.env.OMK_MOCKS_FILE || '';
if (mocksFile && existsSync(mocksFile)) {
  try { strict = JSON.parse(readFileSync(mocksFile, 'utf8')).strict ?? null; } catch { /* ignore */ }
}
process.stdout.write(JSON.stringify({
  output: JSON.stringify({
    hasSettingsEnv: !!process.env.OMK_MOCK_SETTINGS_FILE,
    hasMocksFile: !!process.env.OMK_MOCKS_FILE,
    settingsPath: settings,
    settingsExists: settings ? existsSync(settings) : false,
    strict,
  }),
}));
