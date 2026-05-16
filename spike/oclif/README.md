# omk-oclif-spike

[issue #109](https://github.com/lizhiyao/oh-my-knowledge/issues/109) PR-A 的 oclif 候选 prototype。

实现 omk 三个代表性命令（doctor / sample / studio）的最小可运行版本，验证 6 项 deal-breaker。**不是生产代码**——见 [../README.md](../README.md) 解释跟主项目隔离边界。

<!-- usage -->
```sh-session
$ npm install -g omk-oclif-spike
$ omk-spike COMMAND
running command...
$ omk-spike (--version)
omk-oclif-spike/0.0.0 darwin-arm64 node-v24.14.0
$ omk-spike --help [COMMAND]
USAGE
  $ omk-spike COMMAND
...
```
<!-- usagestop -->

<!-- commands -->
* [`omk-spike doctor`](#omk-spike-doctor)
* [`omk-spike sample SKILLPATH`](#omk-spike-sample-skillpath)
* [`omk-spike studio dump`](#omk-spike-studio-dump)
* [`omk-spike studio start`](#omk-spike-studio-start)

## `omk-spike doctor`

体检 omk 工作目录,检查 skill 配置 / 依赖 / executor 连通性。

```
USAGE
  $ omk-spike doctor [--lang zh|en] [--skill-dir <value>] [--no-cache]

FLAGS
  --lang=<option>      [default: zh, env: OMK_LANG] 输出语言 zh|en,优先级 CLI > OMK_LANG env > zh
                       <options: zh|en>
  --no-cache           跳过连通性缓存,所有探测都重跑(spike 用作 preflight 失败模拟开关)
  --skill-dir=<value>  [default: skills] 要体检的 skill 目录,默认 ./skills

DESCRIPTION
  体检 omk 工作目录,检查 skill 配置 / 依赖 / executor 连通性。

EXAMPLES
  默认在中文模式下扫描当前目录的 skills/

    $ omk-spike doctor

  指定英文 + 跳过连通性缓存(任何缓存命中的网络检测都重跑)

    $ omk-spike doctor --lang en --no-cache
```

## `omk-spike sample SKILLPATH`

为指定 skill 生成评测用例(eval-samples)。

```
USAGE
  $ omk-spike sample SKILLPATH [--lang zh|en] [--count <value>] [--output <value>] [--strategy
    workflow|contrastive|hybrid]

ARGUMENTS
  SKILLPATH  skill 文件或目录的路径,必填

FLAGS
  --count=<value>      [default: 5] 生成多少条样本,默认 5
  --lang=<option>      [default: zh, env: OMK_LANG] 输出语言 zh|en
                       <options: zh|en>
  --output=<value>     输出 JSON 路径,默认 eval-samples.json
  --strategy=<option>  [default: workflow] 采样策略 workflow|contrastive|hybrid
                       <options: workflow|contrastive|hybrid>

DESCRIPTION
  为指定 skill 生成评测用例(eval-samples)。

EXAMPLES
  workflow 策略生成 5 条用例

    $ omk-spike sample skills/code-review

  hybrid 策略生成 10 条 + 自定义输出路径

    $ omk-spike sample skills/code-review --strategy hybrid --count 10 --output out.json
```

## `omk-spike studio dump`

把当前 studio 数据 dump 成 JSON/YAML(给 CI / 外部脚本消费)。

```
USAGE
  $ omk-spike studio dump [--lang zh|en] [--format json|yaml] [--output <value>]

FLAGS
  --format=<option>  [default: json] dump 格式 json|yaml
                     <options: json|yaml>
  --lang=<option>    [default: zh, env: OMK_LANG] 输出语言 zh|en
                     <options: zh|en>
  --output=<value>   输出文件路径,默认 stdout

DESCRIPTION
  把当前 studio 数据 dump 成 JSON/YAML(给 CI / 外部脚本消费)。

EXAMPLES
  JSON 模式 dump 到 stdout

    $ omk-spike studio dump --format json
```

## `omk-spike studio start`

启动 omk studio 报告服务,看 skill 健康/评测/观测三大维度。

```
USAGE
  $ omk-spike studio start [--lang zh|en] [--port <value>] [--no-serve]

FLAGS
  --lang=<option>  [default: zh, env: OMK_LANG] 输出语言 zh|en
                   <options: zh|en>
  --no-serve       只生成报告,不启动 HTTP 服务
  --port=<value>   监听端口,0 表示系统分配

DESCRIPTION
  启动 omk studio 报告服务,看 skill 健康/评测/观测三大维度。

EXAMPLES
  默认端口 0(系统分配可用端口),浏览器自动打开

    $ omk-spike studio start

  指定端口 + 不打开浏览器

    $ omk-spike studio start --port 7799 --no-serve
```
<!-- commandsstop -->

## 跑法

```bash
yarn install
yarn build           # tsc → dist/
yarn start doctor    # 等价于 node bin/run.js doctor
yarn dev doctor      # 等价于 node --import tsx bin/dev.js doctor（不需要 build）
```

## 6 项验收实验

实验脚本与输出快照见 [`experiments/`](./experiments)。每条命令对应 1 个 .txt 快照。

| # | 实验 | 命令 |
|---|---|---|
| 1 | 双语 help | `OMK_LANG=zh yarn start doctor --help` vs `--lang en` |
| 2 | unknown flag exit 2 | `yarn start doctor --no-such-flag; echo $?` |
| 3 | flag 形态 | `yarn start sample`（缺 positional）/ `sample skills/foo --count 5 --strategy hybrid` |
| 4 | subcommand 元数据 | `yarn start studio start --help` / `studio dump --format json` |
| 5 | docs 自动生成 | `yarn manifest` / `yarn readme` |
| 6 | npm 打包形态 | `npm pack --dry-run` 文件列表 + 体积 |

## 文件结构

```
spike/oclif/
├── bin/
│   ├── run.js        # 生产入口,读 dist/
│   └── dev.js        # 开发入口,tsx 直读 src/
├── src/
│   ├── commands/
│   │   ├── doctor.ts
│   │   ├── sample.ts
│   │   └── studio/
│   │       ├── start.ts
│   │       └── dump.ts
│   └── i18n.ts       # 双语 hook 实验
├── experiments/      # 6 项验收输出快照
├── package.json      # @oclif/core ^4 + tsx + typescript 5
└── tsconfig.json     # ES2022 + Node16 + strict
```
