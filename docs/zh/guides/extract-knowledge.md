# 从工作日志提炼候选知识

从一份明确选定的 Codex JSONL 日志提炼事实、案例或方法，然后逐条核对实体、适用条件与原始记录。候选始终等待复核；保留表示愿意维护，不等于内容已证实。命令不会自动修改 AGENTS.md、skill 或其它生效载体。

## 选择来源并生成

明确指定本地知识工作区；CLI 与 Studio 使用同一目录。以下路径和身份均须替换为自己的值：

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
```

可用 `--start-record 10 --end-record 30` 限定范围。序号从零开始，只计非空行，起止均包含。先核对输出中的 `snapshotId`、记录范围、片段与限制。`capture` 只在本地归档，不调用模型。

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model> --json
omk observe knowledge list --workspace ./knowledge --json
```

生成发送归档中的选定片段与覆盖限制，使用明确配置的执行器和模型，可能产生费用。支持 codex、claude、claude-sdk、openai-api、anthropic-api；其它执行器尚未提供此入口。凭证配置沿用对应执行器。原始日志路径和原始记录封装不作为生成输入，但选定片段本身可能包含敏感内容，应先核对。

允许零候选，部分输出不合法时保留拒绝原因。引用匹配只说明位置存在，不能证明陈述为真。来源中的行为、他人说法和提炼推断分别呈现；未知时间与条件不补成确定事实。

## 核对与处理

```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason '后续处理本项目时参考'
```

从最新 `show` 结果读取修订身份与 `history.generation`。`discard` 使用同样参数，记录舍弃理由，不删除历史。并发修改导致版本冲突时，重新读取并核对差异，不能盲目重试旧内容。

修订输入只包含 `title`、`content`、`entities`、`evidence`，可从 `show` 的 `revision` 中取这四项保存为 JSON。修改标题、陈述、实体名称、上下文或证据解释后执行：

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 2 --input ./draft.json --reason '补充适用条件'
```

使用实际读取的 generation，不照抄示例数字。修订生成新版本，旧内容和处理理由仍保留，新版本不继承旧版本的保留选择。原文位置继续绑定；新增实体身份或新来源引用需要新的提炼，不能凭空填入引用。可用 `show --revision <old-revision-id>` 查看旧版本。

## Studio

启动 `omk studio`，使用命令返回的地址。在 Knowledge 页面选择“从工作日志提炼知识”，输入与 CLI 相同的工作区路径并打开。可以选择日志、预览范围、明确执行器与模型后生成；候选与原文并列展示，实体提及可定位到原文，修订／保留／舍弃均使用同一保存协议。处理后重新打开，仍可查看修订历史。

## 中断与来源管理

`generate --run-id <UUID>` 可为一次运行指定稳定身份。相同请求重试不会再次调用模型；修改来源或模型时不要复用该身份。

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

`resume` 只恢复已持久化输出的接纳或保存，不重新调用模型。若进程在保存输出前退出，记录可能仍为 generating；确认原进程已结束后，检查记录并以新的运行身份重新生成。失败或取消不代表完整候选已交付。

工作区含来源快照、候选修订及生成原始输出。它们可能包含私有内容，应按本地数据管理。`delete-source --snapshot <snapshot-id>` 删除来源快照并留下不可用标记，不修改原日志，也不擦除知识修订或生成输出中的引用文字；不要将它当作工作区的彻底清除。来源缺失、损坏或删除后，候选仍保留，但不能再声称原始依据可完整核对。

首次使用请逐条记录来源忠实度、适用范围、未来复用价值，以及误提炼、遗漏和修订原因。自动测试不能替代这项判断。
