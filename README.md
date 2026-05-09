# babata-sidebar

> babata 浏览器扩展 — **all in one**. 渗透到 V 浏览器每个角落: chat sidebar / 整页双语翻译 / 划词翻译 / 视频字幕 / PDF / 漫画 OCR / page agent / bookmarks·tabs·history 全感知. 替代沉浸式翻译 + openclaw-sidebar + 各种单点扩展.

## 设计哲学 (north star)

V 在立项 session 中沉积的三句陈述, 是整个 sidebar 的北极星:

1. **"babata 就是要渗透到我的每个角落, 全面了解我, 成为最懂我的存在"** — 渗透 vision
2. **"活在浏览器里, 一切都要如原生般丝滑"** — UX 原生
3. **"时刻记住, 要从底层完全掌握我的浏览器, 如原生, 如呼吸"** — 技术深度 + 自动化无感

## 当前阶段

✅ **V0 已 ship**: 浏览器扩展源码在本 repo, server 端在 `~/code/babata/sidebar_*.py`.

当前 live subset:
- chat sidebar / page popup iframe / 文件与图片上传
- sidepanel Port sentinel + offscreen WebSocket bridge + SW action dispatcher
- 整页翻译 content script (sibling 注入, bilingual / replace / off)
- proactive trigger / suggestion chips / tab-targeted mascot bubble
- page_snapshot / page_click_ref 可见页面地图 (ref / selector / is_new diff)
- bookmarks / tabs / history raw browser tools

```
research/    7 份深度调研 (Anthropic 反编译 / 沉浸式 / MV3 / a11y tree / 翻译注入 / site profiles / chat extensions)
design/      4 份设计文档 (architecture / decisions 22 项 / roadmap V0/V1/V2 / risks 10 项)
src/         扩展源码 (Preact + Vite + Tailwind + MV3)
```

## 参考来源

| 来源 | 关键信号 |
|------|----------|
| [openclaw-sidebar](https://github.com/r266-tech/openclaw-sidebar) | V 之前为 OpenClaw 做的浏览器侧边栏, 9 核心功能 + agentic page action loop |
| Anthropic Claude in Chrome (Beta) 1.0.70 | A11y tree (page-side `__generateAccessibilityTree`) + offscreen WSS keep-alive + chrome.debugger CDP + native messaging + visual indicator |
| 沉浸式翻译 1.28.5 | 137 站点配置 + 段落识别引擎 + `<font>` 标签 DOM 注入 — 替代目标 |

## 项目结构

```
research/    调研材料 — 7 份, code-grounded
design/      架构与决策文档 — 4 份
src/         扩展源码 (V0 实施)
```

server 端 (`sidebar_bot.py` / `sidebar_mcp.py` / `sidebar_bridge.py`) 进 babata main repo, 不在本 repo. 本 repo = 浏览器扩展.

## 关键决策快查

V 决:
- D1 全渗透不留隐私黑名单
- D2 chrome.debugger V0 标配, 黄条接受
- D3 cross-channel = 读 chat-archive RO + 写自己 state

完整 22 项见 [design/decisions.md](design/decisions.md).

## 本地运行

```bash
npm install
npm run typecheck
npm run build
```

Edge/Chrome 开发者模式加载 `dist/`. server 端由 babata main repo 的
`sidebar_bot.py` 提供 `http://127.0.0.1:18791` + `/ws`.

V0/V1 仍待补齐的核心能力: full a11y tree content script, trusted CDP click/type/screenshot,
per-window session, 统一 tool registry.
