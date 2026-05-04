/**
 * 命令退出信号。execute() / parse-strict / requireEvaluationReport 等想以
 * 特定 exit code 终止时,throw 这个,不要直接 process.exit。
 *
 * dispatcher (`main()` 顶层 catch) 负责把 CliExit 转成 process.exit(code) —
 * 这样 execute() 可以在单测里被 try/catch 捕获,不 kill 整个测试进程。
 *
 * 异步回调内的「子进程 exit code 透传」(commands/report.ts spawn handler)
 * 不走这层,继续 process.exit — 那是子进程退出后的 cleanup,不在 main 调用栈。
 */
export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`CliExit(${code})`);
    this.name = 'CliExit';
  }
}
