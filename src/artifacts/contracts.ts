export type ArtifactKind = 'baseline' | 'skill' | 'prompt' | 'agent' | 'workflow';

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  source: 'baseline' | 'variant-name' | 'file-path' | 'git' | 'inline' | 'custom';
  content: string | null;
  // 整树内容指纹(hashArtifactSource:目录-skill 覆盖整棵可分发树、文件-skill 为单文件字节)。
  // 解析期算好挂在这里，供 Core 封存 artifact descriptor 与 managed contentHash 落在同一空间。
  // 与 `content`(executor 注入的 trim 文本)解耦——指纹不依赖正文文本。
  // baseline / 无 skill 留空。
  contentHash?: string;
  locator?: string;
  ref?: string;
  // 本地 git variant 物化时 ref 解析出的 commit SHA。作为 sealed resource provenance 进入 Core；
  // 不作为 managed 身份，也不生成工作树恢复命令。
  resolvedCommit?: string;
  cwd?: string;
  // SKILL.md 约定的 directory-skill **真源**根目录(doctor 校验、dependency-checker 解析、
  // 同名 variant 消歧都以此为准)。只对 directory-skill 填,file-skill 留空。
  skillRoot?: string;
  // directory-skill 的**隔离执行根**:eval 测量前 copy 出的内容寻址副本(materializeIsolatedCopy)。
  // executor 的 cwd / skillDir 锚到这里 —— 被测 agent 在隔离副本里跑、不碰真源,references/ 资产
  // 是真实运行时输入。与 skillRoot(真源)分离:doctor 等校验真源不受副本影响;execRoot 不序列化进
  // report(只 artifact.cwd 进 variantConfig),故副本路径不污染可比性。
  // task.cwd 优先级:用户显式 cwd(@/path) > execRoot > skillRoot > sample.cwd > null。
  execRoot?: string;
  // run-time 属性:variant 在当次实验中扮演的角色(由 CLI --control/--treatment 或 eval.yaml 注入)
  // 不是 artifact 文件的固有属性;同一 artifact 在不同 run 可以扮演不同角色
  experimentRole?: ExperimentRole;
  // Skill auto-discovery 隔离声明(per-variant)。
  //   undefined → 默认 SDK 行为(全发现 ~/.claude/skills/)
  //   []        → 完全禁用 skill 发现 + Skill 工具 disable(main session + subagent 同堵)
  //   [...]     → 拒绝(非空白名单不再支持:子代理 Skill 工具 + cwd 文件系统通道封不住)
  // baseline-kind 默认 [],由 --strict-baseline (default true) 注入;显式 eval.yaml 优先。
  allowedSkills?: string[];
  metadata?: Record<string, unknown>;
}

export type ExperimentRole = 'control' | 'treatment';
