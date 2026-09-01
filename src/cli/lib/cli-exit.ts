/**
 * 命令退出信号。业务逻辑想以特定 exit code 终止时，
 * throw 这个,不要直接 process.exit。
 *
 * oclif Command.run() 末尾的 try/catch 把 CliExit 转成 this.exit(code);main()
 * 顶层 catch 兜底转 process.exit — 这样业务可以在单测里被 try/catch 捕获,不 kill
 * 整个测试进程。
 *
 * 异步回调内的「子进程 exit code 透传」(如 studio --dev spawn child)不走这层,
 * 继续 process.exit — 那是子进程退出后的 cleanup,不在 main 调用栈。
 */
export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`CliExit(${code})`);
    this.name = 'CliExit';
  }
}
