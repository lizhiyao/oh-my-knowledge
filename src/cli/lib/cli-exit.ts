/**
 * 命令退出信号。业务逻辑想以特定 exit code 终止时，
 * throw 这个,不要直接 process.exit。
 *
 * oclif Command.run() 末尾的 try/catch 把 CliExit 转成 this.exit(code);main()
 * 顶层 catch 兜底转 process.exit — 这样业务可以在单测里被 try/catch 捕获,不 kill
 * 整个测试进程。
 *
 */
export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`CliExit(${code})`);
    this.name = 'CliExit';
  }
}
