/** Mock 命中规则(所有字段 AND,字段未填即不限制)。 */
interface MockMatchBase {
  /** 精确匹配 file_path(用于 Read / Edit / Write,支持 ~ 自动展开)。
   *  注意:claude-cli / claude-sdk 的 PreToolUse hook 拿到的 file_path 是 LLM 调
   *  Read/Edit/Write 时实际传入的字符串。LLM 经常把相对路径写成 cwd 绝对路径
   *  (尤其当 sample.environment.notes 里给了 cwd 提示),mock 用 `file_path` 精确
   *  匹配会 miss。**新 sample 推荐用 `file_path_endswith` 做后缀匹配**,匹配更稳。 */
  file_path?: string;
  /** 后缀匹配 file_path:actual.endsWith(suffix) 且边界为路径分隔符或完全相等。
   *  例如 suffix='tasks/foo/state.json' 命中 'tasks/foo/state.json' /
   *  '/abs/cwd/tasks/foo/state.json' / '~/proj/tasks/foo/state.json' 但不命中
   *  'bad-state.json'。`~` 自动展开。**绝对路径 cwd 不可预测时首选这个字段**。 */
  file_path_endswith?: string;
  /** glob 匹配 command(用于 Bash 拦 mcporter / cli;支持 *)。 */
  command_glob?: string;
  /** 通用匹配:对 tool_input 任意字段做 deep equal,优先级高于上面的 sugar 字段。 */
  input?: Record<string, unknown>;
  /** 递归扫描 tool_input 所有 string 值,任意一个含该子串即命中(大小写不敏感)。
   *  适合 intent-level mock:配合 `tool: "*"` 拦截"任何工具,只要输入提到关键词"。
   *  例: `input_contains: "FinTradeBuySpi"` 命中 Bash grep / Grep / Read 等任何包含该关键词的调用。 */
  input_contains?: string;
}

export type MockMatch = MockMatchBase & (
  | { url: string; url_glob?: never }
  | { url?: never; url_glob: string }
  | { url?: never; url_glob?: never }
);

/** Mock 返回值(三选一)。 */
export type MockReturn =
  | { stdout?: string; stderr?: string; exit?: number; [k: string]: unknown }
  | string;

interface MockBase {
  /** source-neutral 工具身份,如 "Read" / "Bash" / "WebFetch" / "Edit" / "Write" / "Grep" / "Glob"。
   *  executor adapter 会把 runtime-native 名称（如 exec_command / apply_patch）映射后匹配。
   *  特殊值 `"*"`:通配,匹配任何工具名(配合 match.input_contains 做 intent-level mock)。 */
  tool: string;
  /** 命中规则。所有字段 AND,字段未填即不限制。 */
  match?: MockMatch;
}

/** 单条 Mock 规则。runtime 拦到匹配的 tool 调用即返回 mocked 结果,不放出去。 */
export type Mock = MockBase & (
  | {
      /** 返回内容(LLM 看到的 tool_result)。string 直接返回；object 可模拟 Bash。 */
      return: MockReturn;
      return_file?: never;
      return_seq?: never;
    }
  | {
      /** 从外部 fixture 文件读返回内容(路径相对 sample 目录;大响应建议外置)。 */
      return?: never;
      return_file: string;
      return_seq?: never;
    }
  | {
      /** 同 mock 多次命中按序返回；超过序列长度后保持最后一个状态。 */
      return?: never;
      return_file?: never;
      return_seq: MockReturn[];
    }
);
