import type { ExperimentRole, RemoteGitRef } from '../../../knowledge-artifacts/contracts.js';

export interface VariantSpec {
  name: string;           // variant 显示名,从 expr 提取
  role: ExperimentRole;
  expr: string;           // artifact 身份表达式(git: 前缀等),不再编码 @cwd
  // 远端 git 源(结构化);present 时取代 expr 的本地解析,走 resolveRemoteGitSource。
  git?: RemoteGitRef;
  // runtime context cwd,在 CLI/config 边界解析一次后随 spec 结构化携带,内部不再传播 name@cwd 串。
  cwd?: string;
  // 显式 skill 隔离声明(来自 eval.yaml variant.allowedSkills)。随 spec 一起走,
  // 避免再按 variant 名建一张并行 map 与 artifact 名互查(那是 allowedSkills 漏绑的源头)。
  allowedSkills?: string[];
}
