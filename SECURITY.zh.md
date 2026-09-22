# 安全策略

> English source: [Security Policy](./SECURITY.md). This file is maintained section by section against it; the English version is authoritative.

## 支持版本

**只有 1.x 这一条线受支持**：安全修复只落在 1.x，修复合入 `main` 后随下一次发布带出。`0.x` 已不再受支持，即使安全报告也不打补丁。

1.x 目前仍是预发布版本，受支持的构建就是最新的 `1.0.0-beta.*`，npm 用 `next` 这个 dist-tag 提供它——此时 `@latest` 仍指向最后一个 `0.x` 版本：

```bash
npm i -g oh-my-knowledge@next
```

不需要手工挪动 dist-tag：发布流程按被发布的版本号自己决定 tag，所以第一个正式版 `1.0.0` 发布时就会落到 `latest`，此后 `oh-my-knowledge@latest` 装到的就是受支持版本。报告漏洞时请写明你实际运行的版本，通道有影响时附上 `npm view oh-my-knowledge dist-tags` 的结果。

## 报告漏洞

**不要为安全报告开公开的 GitHub issue。**

请使用以下私有渠道之一：

1. **GitHub Security Advisories（首选）** —— [报告漏洞](https://github.com/lizhiyao/oh-my-knowledge/security/advisories/new)
2. **电子邮件** —— coderdancestudio@gmail.com

请一并提供：

- 问题描述及其影响
- 复现步骤（或概念验证）
- 受影响的 `oh-my-knowledge` 版本
- 你建议的修复方案（如有）

## 响应预期

**这是单人维护的开源项目，没有 SLA。** 报告会以尽力而为的方式及时处理：

- 确认收到：通常在 3–5 天内
- 初步评估：通常在 2 周内
- 修复时间：取决于严重程度与复杂度，严重问题优先

如果 2 周内没有收到回复，欢迎重新发送或通过 GitHub 提醒。

## 适用范围

本策略覆盖本仓库中的代码（`oh-my-knowledge` CLI 与库）。以下内容不在覆盖范围内：

- 你配置的第三方执行器（Claude / OpenAI / Gemini 的 CLI 或 SDK）
- 你编写的自定义断言 `.mjs` 文件（它们在你的 Node 进程中执行——请把它们当作你自己写的可信代码）
- 你在 `.mcp.json` 中配置的 MCP server

本工具设计用于**本地可信环境**（开发机、CI）。威胁模型见 [README.md](./README.md) 的「安全说明」（"Security notice"）一节。

## 披露

修复发布后，除非报告人要求匿名，我们会在发布说明中致谢报告人。
