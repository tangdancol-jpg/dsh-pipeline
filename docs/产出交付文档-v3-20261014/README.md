# 交付文档（v3 · 2026-10-14 起）

本目录放**契约与边界说明**、以及可离线打开的架构图；不是过程记录。

| 文件 | 内容 |
|---|---|
| [2026-10-18-面板与客户端分块.md](2026-10-18-面板与客户端分块.md) | 自建面板与客户端分块：路由 / 数据契约 / 8 个写动作 / 落盘位置 / 入口 375 行 + 18 chunk（19 文件、4743 行）/ 弹层 portal 到 `document.body` / 3918 项 119 套 / 已验证与未验项 |
| [架构图-main-path-v3.html](架构图-main-path-v3.html) | 面板主路径三层架构（DSH 宿主 / 插件宿主侧 / 浏览器客户端：入口 → require.async → 18 chunk，弹层 portal → `document.body`），自包含单文件、深浅色可读 |
| [架构图-main-path-v2.html](架构图-main-path-v2.html) | 上一轮的主路径图，**保留作历史**，不再改动 |

配套的设计记录在 `plugin/active/design/`：面板见
[`design/panel/01-面板设计.md`](../../plugin/active/design/panel/01-面板设计.md)，
Agent Teams 与 memory 各有一组同格式文件。
