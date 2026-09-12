# 项目视觉资源

这里保存供手动使用的名称海报。网站和 README 使用的图片位于 [docs/public](../docs/public/)，按引用位置维护。

## 保留资源

| 文件 | 用途 | 维护来源 |
|---|---|---|
| [poster/omk-name-poster.html](./poster/omk-name-poster.html) | “为什么这把尺子叫 omk”名称海报源稿 | 手工维护的 HTML，画布为 1080×1120 |
| [poster/omk-name-poster.png](./poster/omk-name-poster.png) | 名称海报导出图 | 从同目录 HTML 按 2× 比例截图，导出为 2160×2240 |

名称海报用于解释命名，不作为当前功能清单或评测证据。

## 维护约定

- 网站 Logo 与 favicon 直接使用 [docs/public/logo.svg](../docs/public/logo.svg)，它是唯一 Logo 源文件。本目录不维护重复 SVG 或未使用的 PNG 导出图；有明确用途时再按所需尺寸导出。
- 新增图片时记录用途与来源；界面截图应注明对应版本，结果数字应注明证据来源或明确标为示意。
- 已被替换的截图和过期宣传图直接删除，需要历史版本时从 Git 历史查找。
- GitHub 仓库设置中上传的社交预览图属于外部配置，删除本地图片不会自动更新该配置。
