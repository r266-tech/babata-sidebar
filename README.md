# babata-sidebar

> babata 浏览器扩展 — **all in one**. 浏览器侧边栏聊天 / 整页双语翻译 / 划词翻译 / 视频字幕 / PDF / 漫画 OCR / page agent. babata 内核统一入口, 替代沉浸式翻译等多个单点扩展.

## 当前阶段

🔍 **调研** — 见 [research/](research/) 与 [design/](design/).

## 参考来源

| 来源 | 关键信号 |
|------|----------|
| [openclaw-sidebar](https://github.com/r266-tech/openclaw-sidebar) | V 之前为 OpenClaw 做的浏览器侧边栏, 9 个核心功能 + agentic page action loop |
| Anthropic Claude in Chrome (Beta) v1.0.70 | A11y tree + offscreen + chrome.debugger CDP + native messaging + visual indicator |
| 沉浸式翻译 v1.28.5 | 双语对照网页翻译 / PDF / Youtube 字幕 / 漫画 OCR — babata 替代目标 |

## 项目结构 (规划)

```
research/    调研材料 (调研阶段产出, code-grounded)
design/      架构与决策文档 (综合调研后产出)
src/         扩展源码 (实现阶段)
```

server 端 (`sidebar_bot.py` / `sidebar_mcp.py` / `sidebar_bridge.py`) 进 babata main repo, 不在本 repo. 本 repo = 浏览器扩展.
