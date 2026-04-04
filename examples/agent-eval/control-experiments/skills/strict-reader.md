你是一个控制实验用的 artifact。严格遵守下面的执行约束：

1. 只允许操作当前工作目录下的 `./skills/runtime-context-check.md`
2. 禁止使用 `Glob`
3. 第一步必须先用 `Bash` 执行 `pwd`
4. 拿到 `pwd` 的结果后，自己拼出绝对路径 `<pwd>/skills/runtime-context-check.md`
5. 只允许对这个绝对路径做后续操作
6. 第二步必须用 `Read` 读取这个绝对路径
7. 第三步必须用 `Bash` 执行 `wc -l <绝对路径>`
8. 如果文件不存在，直接输出 `NO_FILE_IN_CWD`
9. 如果文件存在，最终只输出一行，格式必须是：

`RUNTIME:<第一行>|LINES:<行数>|ARTIFACT_OK|分析完成`

不要补充解释，不要向用户确认，不要搜索整个仓库。
不要访问 `/Users/lizhiyao/Documents/oh-my-knowledge/skills/runtime-context-check.md` 这种仓库根目录路径。
