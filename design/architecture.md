# babata-sidebar Architecture

## 设计哲学 (north star)

V 在 session 3bc3bc47 中沉积的三句陈述, 是整个 sidebar 的北极星:

1. **"babata 就是要渗透到我的每个角落, 全面了解我, 成为最懂我的存在"** (渗透 vision)
2. **"活在浏览器里, 一切都要如原生般丝滑"** (UX 原生)
3. **"时刻记住, 要从底层完全掌握我的浏览器, 如原生, 如呼吸"** (技术深度 + 自动化无感)

设计铁律 (live / target 分层):

- **全渗透**, 不留隐私黑名单 (V 2026-05-07 明示否决, 见 babata memory `feedback_no_privacy_blacklist.md`)
- **One CPU**, sidebar 跟 TG / 微信 channel 同一个 CC binary (`feedback_one_cpu_many_channels.md`)
- **底层接入**: live 已有 `page_snapshot` / `page_click_ref`; target 是 full A11y tree content script `document_start all_frames` + chrome.debugger CDP trusted input
- **默认 always-on**: live 是 SW / offscreen / widget / translate content script ready; target 是 full a11y tree 预扫描, 不等 V 触发
- **异步学习**: site-profile / chat-archive 复盘永远 offscreen / launchd consumer, 不卡 UI
- **静默自愈**: profile miss / API 错 / SW 重启 全程无 toast 无 badge (`feedback_self_heal_no_escalate.md`)

---

## 拓扑

> Live status (2026-05-09): 下图仍是目标拓扑. 当前代码已落地
> `src/service-worker.ts` / `src/offscreen.ts` / `src/sidepanel.tsx` /
> `src/content/babata-widget.ts` / `src/content/babata-translate.ts` 和 babata
> main repo 的 `sidebar_bot.py` / `sidebar_mcp.py` / `sidebar_bridge.py` /
> `sidebar_translate.py`. 已有可见页面 `page_snapshot` / `page_click_ref`
> (ref / selector / URL-scoped is_new diff) 基础链路, 以及 sidepanel Port
> sentinel 和 tab-targeted mascot bubble. 尚未落地的目标能力包括 full a11y tree content script,
> trusted `chrome.debugger` click/type/screenshot, visual indicator, site profile
> consumer, per-window session, unified tool registry.

```
┌─ V 的 Edge (Profile 1, V 已登录态全保留) ────────────────────────────┐
│                                                                         │
│  ┌─ babata-sidebar 扩展 (单独 repo) ─────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Service Worker (assets/service-worker.ts)                         │ │
│  │    ├─ chrome.runtime.onInstalled / commands / webNavigation        │ │
│  │    ├─ message router (sidepanel ↔ content ↔ offscreen ↔ server)    │ │
│  │    └─ chrome.debugger CDP (Input.dispatch* / Page.captureScreenshot)│ │
│  │                                                                    │ │
│  │  Offscreen Document (offscreen.html, reasons: WORKERS)             │ │
│  │    └─ WSS to babata server (keep SW alive 副作用)                  │ │
│  │                                                                    │ │
│  │  Side Panel UI (sidepanel.html, Preact + Tailwind)                 │ │
│  │    └─ chat / 本站经验 / 浏览器管家 / 设置 四 tab                    │ │
│  │                                                                    │ │
│  │  Content Scripts                                                   │ │
│  │    ├─ accessibility-tree.ts (all_urls all_frames document_start)   │ │
│  │    ├─ agent-visual-indicator.ts (顶 frame document_idle, Shadow DOM)│ │
│  │    ├─ bilingual-translate.ts (DOM 注入 + IntersectionObserver)     │ │
│  │    ├─ selection-popup.ts (Shadow DOM 浮层)                         │ │
│  │    └─ youtube-subs.ts / netflix-subs.ts (V1/V2)                    │ │
│  │                                                                    │ │
│  └────────────────────────────────────────┬───────────────────────────┘ │
│                                           │ HTTP + WS                   │
└───────────────────────────────────────────┼─────────────────────────────┘
                                            │
                       ┌────────────────────▼────────────────────────────┐
                       │  babata server 端 (babata main repo)            │
                       │                                                 │
                       │  sidebar_bot.py    HTTP + SSE + WS, :18791      │
                       │       │                                         │
                       │       └─→ cc.py (channel #3)                    │
                       │              │                                  │
                       │              ├─ ~/cc-workspace/chat-archive/    │
                       │              │  (read-only mount, 跨 channel ctx)│
                       │              ├─ MCP: sidebar_mcp.py             │
                       │              └─ MCP: web-access / second-brain  │
                       │                                                 │
                       │  sidebar_bridge.py  Unix socket                 │
                       │    /tmp/babata-sidebar-bridge.sock              │
                       │       └─→ MCP tools 反向回流到扩展              │
                       │                                                 │
                       │  Site profile 异步 evolver                      │
                       │    launchd com.babata.sidebar-profile-consumer  │
                       │    每 5min pull 扫 runs.jsonl, 跑 LLM 改 .md    │
                       └─────────────────────────────────────────────────┘
```

---

## 浏览器扩展组件

| 组件 | 文件 | 职责 |
|------|------|------|
| Service Worker | `src/service-worker.ts` | message router / sidepanel Port sentinel / commands / webNavigation / raw DOM + visible page snapshot/ref actions + browser keeper actions |
| Offscreen Document | `src/offscreen.html` + `src/offscreen.ts` | 持 WS to babata server, 抗 MV3 SW idle kill; 双向转发 SW request/response |
| Side Panel UI | `src/sidepanel.html` + `src/sidepanel.tsx` | chat / streaming markdown / history restore / file-image-video upload / suggestion chips |
| Widget | `src/content/babata-widget.ts` | page floating entry, translation mode popover, page popup iframe, tab-targeted mascot bubble |
| Bilingual Inject | `src/content/babata-translate.ts` | DOM sibling 注入 `.bbt-tr`, batch translate, SPA mutation recovery, trace/attention push |
| A11y Content Script | planned `content/accessibility-tree.ts` | DOM → ax tree 单行扁平; 当前尚未实现 |
| Visual Indicator | planned `content/agent-visual-indicator.ts` | Shadow DOM phantom cursor / glow border / stop button; 当前尚未实现 |
| Selection Popup | planned `content/selection-popup.ts` | 划词浮层 Shadow DOM; 当前尚未实现 |

---

## babata server 组件 (在 babata main repo)

| 组件 | 文件 | 职责 |
|------|------|------|
| HTTP/SSE/WS server | `sidebar_bot.py` | 接收扩展 HTTP 请求 + SSE 流式回 + WS bridge for 实时 |
| MCP tools | `sidebar_mcp.py` | 暴露给 CC: tab_metadata / dom_* / page_snapshot / page_click_ref / bookmarks_* / tabs_* / history_* |
| Bridge | `sidebar_bridge.py` | Unix socket `/tmp/babata-sidebar-bridge.sock`, 跟 `bridge.py` / `weixin_bridge.py` 同构, MCP → 扩展反向 |
| CC channel #3 | `cc.py` 改 | 加 `source_prompt_sidebar` + `state_file=~/.babata/sidebar/state.json` |
| Site profile evolver | `scripts/sidebar-profile-consumer.sh` | launchd `com.babata.sidebar-profile-consumer` 每 5min, 跟 `~/.claude/skills/skill-evolve/consumer.sh` 同构 |

---

## 数据流

### 用户消息 (sidebar chat)

```
sidepanel.tsx 发送 → SW.runtime.onMessage → fetch http://127.0.0.1:18791/chat (POST SSE)
  → sidebar_bot.py 启 cc.py session (resume per-channel state)
  → cc.py spawn CC subprocess (CLAUDE_CLI_PATH 跟 TG/微信 同 binary)
  → 流式 SSE 回 → SW 转发 → sidepanel.tsx 增量 markdown 渲染
```

### Page action (LLM 调 MCP tool)

```
CC tool_use sidebar_mcp.page_snapshot(tab_id=...)
  → sidebar_mcp.py 通过 sidebar_bridge.sock 发 {action:"page_snapshot"}
  → SW chrome.scripting.executeScript 生成可见元素 ref / selector / is_new
  → CC tool_use sidebar_mcp.page_click_ref(snapshot_id="...", ref="e42")
  → sidebar_bot.py WS 推到扩展 SW
  → SW 用 snapshot 存储的 selector scrollIntoView + synthetic .click()
  → result 反向回流
  → CC 看到 tool_result 继续推理
```

V1 再把 `page_click_ref` 底层从 synthetic `.click()` 升级为
`chrome.debugger` trusted input, 并补 visual indicator.

### Site profile lookup

```
content script 启动 → 读 location.hostname → SW.runtime.sendMessage profile_lookup(domain)
  → SW fetch http://127.0.0.1:18791/profile/<domain>
  → sidebar_bot.py 读 ~/.babata/sidebar/sites/<domain>.md (fs read < 10ms)
  → 返回 frontmatter + anchors + noise + quirks
  → content script 应用 noise filter, 后续 a11y tree 提取已干净
  → 同时 fire-and-forget POST runs.jsonl 一行 (structural-only)
```

### 翻译 (划词)

```
content script selectionchange → SW → fetch /translate (POST { text, source: page_url })
  → sidebar_bot.py 调 cc.py 翻译 prompt (复用同 channel session)
  → SSE 流式回 → SW → content script Shadow DOM 浮层增量渲染
```

### 浏览器管家 (V "整理 tabs")

```
sidepanel "整理我的 tabs" → /chat → cc.py → CC tool_use sidebar_mcp.tabs_list
  → sidebar_mcp.py → SW chrome.tabs.query → 返回所有 tab 元数据
  → CC 分析 + tool_use sidebar_mcp.tabs_group({groupName: "工作", tabIds: [...]})
  → SW chrome.tabGroups.create + chrome.tabs.group
  → result 回 → CC 继续直到全部整理完
```

---

## Site profile system

详见 `research/06-site-profiles.md`. 3 个核心:

**1. 三层物理结构** (跟 skill-evolve 同构)

```
~/.babata/sidebar/sites/
  x.com.md                # 规则层 (V 个人化 + 公共层 lockfile)
  x.com.runs.jsonl        # 事实层 (structural-only fingerprint)
  x.com.evolutions.md     # 元规则层 (复盘 / V 撤回记录)
```

**2. 公共层 OSS** `r266-tech/babata-site-profiles` (V1+):

```
sites/x.com.md            # 普世 anchor / page type / SPA quirks
schema/profile.schema.json
ci/validate.ts            # PR 自动 puppeteer 验 selector 活性
```

私层用 frontmatter `upstream: r266-tech/babata-site-profiles@<commit>` lockfile-style pin.

**3. 异步演化**:

```
launchd com.babata.sidebar-profile-consumer (每 5min)
  └─ pull runs.jsonl 新条目 → spawn CC sub-agent → 改 .md → write-gate review → 落盘
```

**PII 铁律**: runs.jsonl 只存 structural fingerprint (role / count / depth / page_type), 永不存 text content / user names / form values. 判据: 把 jsonl dump 给陌生人能否猜到 V 看了什么 / 是谁 — 能就设计错.

---

## 跨 channel 上下文

V 决策 (read-only chat-archive):

```
sidebar_bot.py 启动 → 挂 ~/cc-workspace/chat-archive/ 只读
cc.py source_prompt_sidebar 注入 system prompt:
  "你能看到 V 在 TG / 微信 channel 跟 babata 的对话历史 (read-only mount)"
sidebar 自己 state 写 ~/.babata/sidebar/state.json (独立 channel)
```

不做 cross-channel session merge — 各 channel 长 session 独立, 但共享 chat-archive 作为 long-term memory. V 在 TG 说过的事 sidebar babata 知道, 但 sidebar 自己说的事 TG babata 也通过 chat-archive 看到 (双向 read).

---

## Permission + CSP

`src/manifest.json` (V0 一次申请全, V 自装自用; live list):

```json
{
  "manifest_version": 3,
  "permissions": [
    "sidePanel", "storage", "tabs", "tabGroups",
    "bookmarks", "history", "downloads",
    "scripting", "debugger",
    "alarms", "notifications", "offscreen",
    "webNavigation", "activeTab", "unlimitedStorage",
    "contextMenus"
  ],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' http://127.0.0.1:18791 ws://127.0.0.1:18791;"
  }
}
```

V0 不要 `cookies` (banking 场景留 V1 评估; chrome.debugger Network domain 已能间接拿 cookie).

---

## 安装 + lifecycle

**首次安装** (V 自手动):

1. `cd ~/code/babata && git pull` 拉 sidebar_bot.py 等 server 端
2. `cd ~/code/babata-sidebar && npm install && npm run build` 编扩展
3. Edge `edge://extensions/` 开发者模式 → 加载已解压扩展 → 选 `dist/`
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.babata.sidebar-bot.plist`
5. sidebar 自动连接 127.0.0.1:18791 + 验证 ready

**自启**: launchd `com.babata.sidebar-bot` 跟 `com.babata` (TG bot) 同模式, KeepAlive=true. Edge 启动时扩展 SW 立即激活 (always-on 哲学).

**自更新**: `scripts/auto-update.sh` 每天 cron 拉两个 repo, server 端走 `scripts/self-ops.sh restart` (铁律), 扩展端 V 手动 `npm run build` 后 Edge 自动 reload (扩展自更新需 Web Store, V0 不上).

---

## 跟 babata 哲学骨架对照自审

- **骨架 1 (单 CPU)**: sidebar 是第 3 channel, CC binary 跟 TG/微信同一个 ✓
- **骨架 2 (事实 > 规则)**: site profile runs.jsonl 是事实, .md 是规则, evolutions.md 是元规则 ✓
- **骨架 3 (不压 LLM 上限)**: a11y tree raw 暴露给 LLM, profile.md LLM 可读可改, 不预封装 workflow ✓
- **骨架 4 (能自愈别吵)**: profile miss 静默回退 Readability, SW 重启自动 hydrate, 不 toast V ✓
- **骨架 5 (薄优先)**: V0 不引 DB / 不引 vector / 不引外部 service ✓

跟 V 渗透哲学三角对齐:
- 时间维度 → memory v2 + chat-archive
- **空间维度 → sidebar 进每个浏览器 tab + bookmarks/tabs/history/downloads 全感知**
- 终态野心 → 统治宇宙
