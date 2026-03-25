---
name: aima-kg-mem-cc
description: 在对话结束后自动提炼对话内容，检测分类并存储到 .aima/memory/{IP}/{分类}/{时间戳}-{对话简介}.md。支持 Stop hook 自动触发、用户确认流程、快捷命令和自然语言触发。
hooks:
  Stop:
    - matcher: "*"
      hooks:
        - type: command
          command: "./scripts/session-memory-hook.sh"
          timeout: 120
---

# AIMA Session Memory - 对话记忆技能

## 核心能力

本技能在对话结束时自动执行以下流程：

1. **对话提炼**：使用 AI（Haiku）压缩提炼对话核心内容，与 claude-mem 的详细程度保持一致
2. **分类检测**：自动识别对话内容所属类别
3. **用户确认**：在存储前展示提炼结果，等待用户确认
4. **分类存储**：保存到 `.aima/memory/{机器 IP}/{分类}/{时间戳}-{对话简介}.md`

## 分类体系

| 分类 | 描述 | 检测关键词/模式 |
|------|------|----------------|
| `technical` | 技术方案、架构设计、代码实现 | 技术方案、架构、设计模式、代码实现、算法 |
| `troubleshooting` | 问题排查、错误解决、Debug | 错误、异常、Bug、修复、解决方案、排查 |
| `workflow` | 工作流程、效率技巧、工具使用 | 工作流、效率、工具、脚本、自动化 |
| `project` | 项目特定知识、业务逻辑 | 项目、业务、需求、功能、模块 |
| `general` | 通用知识、最佳实践 | 最佳实践、经验、总结、方法论 |

## 存储结构

```
.aima/memory/
└── {机器 IP}/
    ├── technical/
    │   └── 20260325_143022-React 组件架构设计.md
    ├── troubleshooting/
    │   └── 20260325_151045-数据库连接超时修复.md
    ├── workflow/
    │   └── 20260325_160230-Git 工作流优化.md
    ├── project/
    │   └── 20260325_172015-支付模块业务流程.md
    └── general/
        └── 20260325_180500-代码审查最佳实践.md
```

## 触发方式

### 1. Stop Hook 自动触发（推荐）

在 `~/.claude/settings.json` 中配置：

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/skills/aima-kg-mem-cc/scripts/session-memory-hook.sh",
        "env": {
          "AUTO_CONFIRM": "false"
        }
      }]
    }]
  }
}
```

**配置说明**：
- `AUTO_CONFIRM=false`（默认）：每次存储前需要用户确认
- `AUTO_CONFIRM=true`：完全自动保存，无需确认

### 2. 快捷命令触发

在对话中输入以下命令之一：
- `/session-memory` - 手动触发当前对话的提炼和存储
- `/mem-save` - 快捷命令，同上
- `/save-memory` - 别名

**命令选项**：
```bash
/session-memory [--auto-confirm] [--compression-level short|medium|long]

选项:
  --auto-confirm          跳过用户确认直接保存
  --compression-level     压缩详细程度：short(100-200 字) / medium(300-500 字) / long(500-800 字)
```

### 3. 自然语言触发

**配置方法**：在 `~/.claude/settings.json` 中添加 UserPromptSubmit hook：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": ".*(总结 | 记录 | 保存 | 记住 | 存储 | 记住).* (讨论 | 内容 | 知识点 | 经验 | 方案 | 对话).*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/skills/aima-kg-mem-cc/scripts/session-memory-command.sh",
        "env": {
          "AUTO_CONFIRM": "false"
        }
      }]
    }]
  }
}
```

**触发关键词**：
- "总结一下今天的讨论"
- "把刚才的内容记录下来"
- "保存这次对话的知识点"
- "记住这个技术方案"
- "把这个经验存下来"
- "今天讨论了什么，帮我记一下"
- "整理一下这次对话的收获"

## 文档格式

生成的 markdown 文档格式如下：

```markdown
---
timestamp: 2026-03-25T14:30:22+08:00
category: technical
session_id: 20260325_143022
machine_ip: 192.168.1.100
---

# React 组件架构设计

## 核心内容

本次对话讨论了 React 函数组件的架构设计模式，主要包括：

1. **自定义 Hook 封装**：将业务逻辑提取到 useHook 中，保持组件简洁
2. **状态提升模式**：将共享状态提升到父组件，通过 props 传递
3. **Memo 优化策略**：使用 React.memo 避免不必要的重渲染
4. **组合模式**：通过组合而非继承实现代码复用

## 上下文

在开发用户列表页面时，遇到了组件重渲染过多和逻辑重复的问题。
通过引入自定义 Hook 和合理的状态管理，解决了性能瓶颈。

## 技术方案

### 1. 自定义 Hook 设计
```typescript
function useUserList(filters: UserFilters) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  // 数据获取逻辑
  // 错误处理
  // 缓存策略

  return { users, loading, refresh };
}
```

### 2. 性能优化要点
- 使用 useMemo 缓存计算结果
- 使用 useCallback 缓存函数引用
- 虚拟列表优化大数据渲染

## 可复用的洞察

1. **Hook 优先**：新功能优先考虑用 Hook 封装
2. **状态最小化**：只保存必要的状态，派生状态用 useMemo
3. **错误边界**：在组件树外层添加 ErrorBoundary

## 相关文件

- src/hooks/useUserList.ts
- src/components/UserList/UserList.tsx
- src/components/UserList/UserItem.tsx
```

## 工作流程详解

### Stop Hook 流程

```bash
# 1. Hook 脚本被调用，接收 transcript_path
# 2. 检查会话长度（默认最少 5 条消息）
# 3. 获取机器 IP 地址
# 4. 调用 Python 脚本进行 AI 提炼和分类
# 5. 展示提炼结果，等待用户确认（除非 AUTO_CONFIRM=true）
# 6. 用户确认后保存到对应分类目录
```

### 快捷命令/自然语言触发流程

```
用户触发命令/自然语言
        ↓
读取当前会话 transcript
        ↓
调用 AI 进行内容提炼和分类
        ↓
展示结果并等待确认
        ↓
用户确认 → 保存文档
用户取消 → 放弃保存
```

## 配置选项

编辑 `config.json` 进行自定义：

```json
{
  "min_session_length": 5,
  "memory_path": ".aima/memory",
  "auto_confirm": false,
  "compression_detail_level": "medium",
  "categories": ["technical", "troubleshooting", "workflow", "project", "general"],
  "include_code_snippets": true,
  "include_file_references": true,
  "max_content_length": 2000
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `min_session_length` | 5 | 最少消息数，短于此时不触发 |
| `memory_path` | `.aima/memory` | 存储路径 |
| `auto_confirm` | false | 是否自动确认保存 |
| `compression_detail_level` | "medium" | 压缩详细程度：short/medium/long |
| `include_code_snippets` | true | 是否包含代码片段 |
| `include_file_references` | true | 是否包含相关文件引用 |
| `max_content_length` | 2000 | 核心内容最大字数 |

## 相关脚本

- `scripts/session-memory-hook.sh` - Stop hook 入口脚本
- `scripts/session-memory-cli.py` - Python 核心处理脚本（AI 调用、分类、存储）
- `scripts/session-memory-command.sh` - 快捷命令入口脚本
- `scripts/get-machine-ip.sh` - 获取机器 IP 地址

## 快捷命令使用示例

```bash
# 基础用法（需要确认）
./scripts/session-memory-command.sh

# 自动确认保存
./scripts/session-memory-command.sh --auto-confirm

# 指定详细程度
./scripts/session-memory-command.sh --compression-level long

# 指定 transcript 路径
./scripts/session-memory-command.sh --transcript ~/.claude/projects/my-project/session-123.jsonl
```

## 与 claude-mem 的压缩保持一致

claude-mem 的压缩特点：
- 保留关键事实和决策
- 记录问题 - 解决方案对
- 提取可复用的模式
- 长度适中（约 300-500 字核心内容）

本技能使用相同的压缩策略，确保信息密度和可读性。

## 示例交互

### Stop Hook 自动触发场景

```
[对话结束，Stop hook 触发]

[后台执行提炼和分类]

📋 对话记忆摘要

分类：technical
标题：React 组件架构设计

核心内容：
本次对话讨论了 React 函数组件的架构设计模式，主要包括：
1. 自定义 Hook 封装...
2. 状态提升模式...
3. Memo 优化策略...

是否保存此对话记忆？(回复"确认"保存，"取消"放弃)

用户：确认

✅ 已保存到：.aima/memory/192.168.1.100/technical/20260325_143022-React 组件架构设计.md
```

### 快捷命令触发场景

```
用户：/mem-save

📋 正在提炼当前对话...

[提炼完成后展示摘要和分类]

是否保存？(确认/取消)

用户：确认

✅ 保存完成
```

### 自然语言触发场景

```
用户：好的，问题解决了。总结一下今天的讨论

📋 正在提炼当前对话...

[同上]
```

## 注意事项

1. **IP 地址获取**：使用 `ifconfig` 或 `ipconfig` 获取本机主要 IP 地址
2. **分类准确性**：AI 分类基于内容语义，如有误判可在确认时手动调整
3. **重复检测**：如检测到相似内容，会提示用户是否合并
4. **隐私保护**：自动过滤敏感信息（密钥、密码等）

## 依赖要求

- **Python 3.6+**：用于运行核心处理脚本
- **anthropic SDK**：用于 AI 调用（可选，如不安装则使用 fallback 模式）
- **jq**：用于 JSON 解析（可选）

安装 anthropic SDK：
```bash
pip install anthropic
```

## 安装步骤

1. **复制 skill 到技能目录**：
   ```bash
   # 如果是本地 skill 目录
   cp -r aima-kg-mem-cc ~/.claude/skills/

   # 或在 aima-skill 项目中
   # skill 已在 .aima/skills/aima-kg-mem-cc/
   ```

2. **添加执行权限**：
   ```bash
   chmod +x scripts/*.sh scripts/*.py
   ```

3. **配置 Stop hook**（自动触发）：
   编辑 `~/.claude/settings.json`，添加：
   ```json
   {
     "hooks": {
       "Stop": [{
         "matcher": "*",
         "hooks": [{
           "type": "command",
           "command": "~/.claude/skills/aima-session-memory/scripts/session-memory-hook.sh"
         }]
       }]
     }
   }
   ```

4. **验证安装**：
   ```bash
   # 运行帮助命令
   ./scripts/session-memory-command.sh --help
   ```