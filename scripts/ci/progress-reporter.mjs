import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * CI 崩溃定位用的进度 reporter：每个测试文件的开始／结束各落一行到诊断目录的
 * `tests-progress.log`。进程被信号杀死时，日志里最后一条 `start` 没有配对 `end`，
 * 那就是死亡现场——不再只有「哪些文件跑完了」。诊断失败不得反过来影响测试：所有写入都容错。
 */
export default class ProgressReporter {
  constructor() {
    this.file = process.env.CI_DIAGNOSTICS_DIR ? join(process.env.CI_DIAGNOSTICS_DIR, 'tests-progress.log') : undefined;
  }
  mark(phase, testModule) {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${new Date().toISOString()} ${phase} ${testModule.moduleId}\n`);
    } catch { /* 诊断绝不搞挂测试 */ }
  }
  onTestModuleStart(testModule) { this.mark('start', testModule); }
  onTestModuleEnd(testModule) { this.mark('end  ', testModule); }
}
