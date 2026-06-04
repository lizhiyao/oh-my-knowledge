# 文档站部署（Cloudflare Pages）

omk 文档站用 [VitePress](https://vitepress.dev) 构建，内容源就是本仓库的 `docs/`（en 在根、zh 在 `docs/zh/`），产物在 `docs/.vitepress/dist/`（已 gitignore）。部署走 Cloudflare Pages 的控制台 Git 集成：连一次仓库，之后 push 到 `main` 自动构建上线，零 secrets、零 workflow 文件。

## 本地预览

```bash
yarn docs:dev       # 热更开发服务器，改 md 即时刷新
yarn docs:build     # 生产构建到 docs/.vitepress/dist/
yarn docs:preview   # 本地起服务预览构建产物
```

## Cloudflare Pages 控制台设置（一次性）

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选 `lizhiyao/oh-my-knowledge`。
2. 构建设置：

   | 项 | 值 |
   | --- | --- |
   | Framework preset | `None`（有 VitePress 选项也可） |
   | Build command | `yarn docs:build` |
   | Build output directory | `docs/.vitepress/dist` |
   | Root directory | 留空（= 仓库根） |

3. Node 版本由仓库根的 `.node-version`（`24`）提供。若构建机的 `yarn install` 报 engine 不兼容（仓库部分 devDep 要求 Node `^22.22.2 || ^24.15.0 || >=26`），在项目 **Settings → Environment variables** 显式加 `NODE_VERSION=24`；仍不行再加 `YARN_IGNORE_ENGINES=true` 兜底。
4. **Production branch** 设为 `main`（站点随 main 更新）；其它分支的 PR 会自动得到 preview 部署，便于改文档时先看效果。
5. 保存 → 触发首次构建。线上地址 `<project>.pages.dev`，根路径提供，所以 VitePress **不需要配 `base`**。

## 自定义域名（可选）

项目 → **Custom domains** → 加域名，按提示在 DNS 加 CNAME 即可，免费。

## 注意

- 构建命令**不**重新生成 `docs/reference/cli.md`。该文件是 `yarn build:docs` 从 CLI flag 生成、committed 进仓库、并由 `build:docs:check` drift gate 保在 `main` 上最新；站点直接消费即可。改了 CLI flag 后记得本地 `yarn build:docs` 提交更新后的 reference，站点才会跟上。
- 当前 VitePress 配置 `ignoreDeadLinks: true`（既有 md 按 GitHub 相对链接写的，先放过保证构建绿）。日后收紧时去掉它再 `yarn docs:build`，按报错修红链。
