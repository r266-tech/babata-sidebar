# 03 - MV3 现代扩展架构 + API 决策

## 总览

MV3 跟 MV2 的关键差异 (跟 babata-sidebar 强相关的部分):

- **后台**: persistent background page → service worker (event-driven, 30s idle 即停, 单 event 5min 硬 cap)
- **网络拦截**: `webRequestBlocking` 退役 → `declarativeNetRequest` (静态 + 动态规则, 不再回调 JS)
- **远程代码**: 禁止 (CSP `script-src 'self' 'wasm-unsafe-eval'`, 不再 `unsafe-eval`/远程 CDN)
- **DOM 后台访问**: 没了 (SW 没 window/document) → `chrome.offscreen` API 补
- **侧边栏**: 新增 `chrome.sidePanel` (替代 popup 长驻场景)
- **content script 动态注入**: `chrome.tabs.executeScript` → `chrome.scripting.executeScript` (支持 MAIN/ISOLATED world)
- **host_permissions**: 从 `permissions` 拆出来独立字段
- **action**: 统一 (browser_action / page_action 合并成 `action`)

### babata-sidebar 推荐技术栈

| 维度 | 选型 | 理由 |
|---|---|---|
| Manifest | MV3 (`manifest_version: 3`) | Edge/Chrome 唯一选项, 2026 已无回头路 |
| UI 容器 | `chrome.sidePanel` (global, openPanelOnActionClick) | 长驻聊天窗, popup 一关就死不能用 |
| 后台 | service worker `background.service_worker` (ES module) | 唯一选项 |
| 长连接 | offscreen document (reasons: `WORKERS`) 持 WSS | SW 30s 死, offscreen 持 WSS 反向 keep SW |
| 自动化 | `chrome.debugger` + CDP (黄条) + `chrome.scripting` (无黄条) 双模式 | 黄条挡反检测, 普通操作走 scripting |
| 网络改写 | `chrome.declarativeNetRequest` 动态规则 | 替换 .vtt URL / 加 header / blocklist |
| 路由感知 | `chrome.webNavigation.onHistoryStateUpdated` + `onCompleted` | SPA YouTube/X 路由变化必走 history API |
| 存储 | `local` (config + chat) + `session` (临时 token + cache) + IndexedDB (大对象) | sync 100KB 太小不用 |
| 后端桥接 | `nativeMessaging` 优先 + HTTP 127.0.0.1 fallback | nativeMessaging 跟扩展生命周期绑死无端口暴露; HTTP 给 Tailscale 跨机访问 |
| OAuth | `chrome.identity.launchWebAuthFlow` + PKCE | Anthropic / 自建 OAuth 通用 |
| 网页桥 | `externally_connectable.matches` + `onMessageExternal` | babata.icu 直接调扩展 |
| CSP | 默认 + `connect-src` 显式列 (loopback + WSS + Anthropic) | 默认 CSP 不让 fetch 任意 origin |

---

## 1. sidePanel API

**关键 API**: `chrome.sidePanel.open(options)` / `setOptions({tabId, path, enabled})` / `setPanelBehavior({openPanelOnActionClick: true})`

文档: https://developer.chrome.com/docs/extensions/reference/api/sidePanel

- **toggle 不存在原生 API**: `sidePanel.open()` 只开不关, `close()` 只关. toggle 要在 SW 里维护 open 状态自己判断.
- **per-tab vs global**: `setOptions({tabId, ...})` 是 per-tab 配置; 不传 `tabId` = 全局. 切 tab 时自动按 tab 配置切换.
- **必须 user gesture**: `open()` 必须在 user action 回调内调 (action click / commands.onCommand / 用户在扩展页面点击都算). SW 自发调会抛错.
- **`_execute_action` 不替你开 sidePanel**: commands 没有 `_execute_side_panel`, 必须监听 `chrome.commands.onCommand` 自己调 `sidePanel.open()`. keyboard shortcut 计为 user gesture.
- **限制页面**: `chrome://*` / `chrome-extension://*` (其他扩展) / Chrome Web Store 上无法注入 content script, sidePanel 仍可显示但 contextual 功能受限.
- **大小**: 用户拖拽宽度, 没有扩展可控的 width/height API. 文档无 size cap, 实测最小 ~280px.

**babata-sidebar 用法**: manifest 配 `side_panel.default_path: "sidepanel.html"` + `setPanelBehavior({openPanelOnActionClick: true})`; toggle 用 `chrome.commands.onCommand` 监听 `Ctrl+Shift+B`, SW 内维护 `isOpen` 状态调 `open` / `close` 切换.

---

## 2. offscreen documents

**关键 API**: `chrome.offscreen.createDocument({url, reasons, justification})` / `closeDocument()` / `hasDocument()`

文档: https://developer.chrome.com/docs/extensions/reference/api/offscreen

- **完整 reasons 列表 (15 个)**: `TESTING` / `AUDIO_PLAYBACK` / `IFRAME_SCRIPTING` / `DOM_SCRAPING` / `BLOBS` / `DOM_PARSER` / `USER_MEDIA` / `DISPLAY_MEDIA` / `WEB_RTC` / `CLIPBOARD` / `LOCAL_STORAGE` / `WORKERS` / `BATTERY_STATUS` / `MATCH_MEDIA` / `GEOLOCATION`.
- **持久 WSS 选 `WORKERS`** (语义最近, 表示扩展用 worker-like 长任务). `IFRAME_SCRIPTING` 是嵌入第三方 iframe 跑脚本, 语义不对.
- **同时只能一个 offscreen** (split incognito 模式下普通 + 隐身各一个).
- **生命周期**: 除 `AUDIO_PLAYBACK` 30s 无音频自杀, 其他 reason 持续到 `closeDocument()` / 扩展卸载/重启. **不跟 SW 同生命周期**: SW 死 offscreen 不死; offscreen 内活动 (postMessage) 反向 wake SW.

**babata-sidebar 用法**: 创一个 offscreen `reasons: ['WORKERS']` 持 Anthropic streaming WSS (或 fetch SSE). offscreen 收到流式 token 用 `chrome.runtime.sendMessage` 转发 SW + sidePanel UI; 同时 offscreen ↔ SW 的 message 自动 keep SW alive (Chrome 109+).

---

## 3. Service Worker 生命周期

**文档**: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

- **30s idle timeout**: 无事件 30 秒后停. 重置 timer 的活动:
  - 任何 `chrome.*` API 调用 (Chrome 110+)
  - 收到 event (alarms / runtime.onMessage / webNavigation 等)
  - offscreen postMessage (Chrome 109+)
  - WSS send/recv (Chrome 116+)
  - `runtime.connect()` long-lived port message (Chrome 114+)
  - `connectNative` message (Chrome 105+)
- **5 分钟硬 cap**: 单事件超 5min (单 fetch 超 30s) 直接被杀, 不可绕.
- **keep-alive 模式实测**:
  - `chrome.alarms` 0.5min 周期 + alarm handler — 简单稳, 推荐 fallback
  - offscreen 持 WSS 双向心跳 — 唯一能保证 truly persistent 的方法
  - **不要** `setInterval` (SW idle 后定时器丢)
- **state hydration**: 全局变量必丢, 用 `chrome.storage.session` 存热数据 (in-memory, SW 重启后存活, 浏览器重启清), `chrome.storage.local` 存配置/聊天.
- **顶层 listener 必须同步注册**: SW 加载时 (顶层 import + `chrome.runtime.onInstalled.addListener`) 必须立即注册, 否则唤醒 event 丢.

**babata-sidebar 用法**: SW 顶层注册所有 listener (commands / runtime.onMessage / webNavigation / alarms); 持久化用 `local` (聊天/配置) + `session` (current sessionId / streaming state) 双层; 长连接交给 offscreen 不在 SW 里直接持 WSS.

---

## 4. chrome.debugger CDP

**关键 API**: `chrome.debugger.attach({tabId}, "1.3")` / `sendCommand({tabId}, method, params)` / `detach({tabId})`

文档: https://developer.chrome.com/docs/extensions/reference/api/debugger

- **黄条不可定制不可隐藏**: attach 时浏览器顶部出现 "<扩展名> started debugging this browser. Cancel" 黄条. 用户点 Cancel = 立即触发 `onDetach({reason: "canceled_by_user"})`. 扩展无 API 隐藏/换文案.
- **同 tab 互斥 DevTools**: 用户打开 DevTools 会强制 detach; 反之扩展 attach 时 DevTools 显示 "Another debugger is already attached".
- **可用 CDP domains**: Accessibility / Audits / CacheStorage / Console / CSS / Database / Debugger / DOM / DOMDebugger / DOMSnapshot / Emulation / Fetch / IO / Input / Inspector / Log / Network / Overlay / Page / Performance / Profiler / Runtime / Storage / Target / Tracing / WebAudio / WebAuthn (无 SystemInfo / Browser).
- **常用 method**: `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Page.captureScreenshot` (含 `clip` + `fromSurface`) / `Runtime.evaluate` / `DOM.querySelector` + `DOM.resolveNode` / `Accessibility.getFullAXTree`.
- **trusted vs synthetic**: `Input.dispatchMouseEvent` 走浏览器输入栈, `isTrusted=true`, 能过 reCAPTCHA / 银行表单. `chrome.scripting` 注入 `el.click()` 是 `isTrusted=false`, 风控直接拒.

**babata-sidebar 用法**: 默认走 `chrome.scripting` (无黄条, 体验顺); 用户显式触发 "agent mode" / 遇到验证码场景才 attach debugger. 黄条用户教育: 一句"为啥有黄条"提示 + 一键退出 agent mode 自动 detach.

---

## 5. chrome.scripting

**关键 API**: `chrome.scripting.executeScript({target, func, args, world, injectImmediately})` / `insertCSS` / `removeCSS`

文档: https://developer.chrome.com/docs/extensions/reference/api/scripting

- **world 两个值**: `MAIN` (页面 JS 上下文, 共享 window/变量, 无 chrome.* API, 绕扩展 CSP eval) / `ISOLATED` (默认, 扩展隔离世界, 有 chrome.* 子集).
- **target**: `tabId` 必传; `frameIds` (具体 frame) / `allFrames: true` (所有 frame, 跟 frameIds 互斥) / `documentIds` (Chrome 106+).
- **args 必须 JSON 可序列化**: function 不可传, 闭包/绑定全丢. `func` 自己也是序列化后反序列化, 闭包外变量丢.
- **MAIN world 用例**: 读页面全局 (React 内部 props / Vue store / 页面挂的 SDK), 调页面内 SDK; 反之 chrome.* API 只能 ISOLATED.

**babata-sidebar 用法**: 默认 ISOLATED 跑选区抓取 / 翻译注入. MAIN 留给"读 SPA 内部状态" (e.g. YouTube player 实例 / X store) 这种必须穿透页面的场景.

---

## 6. nativeMessaging vs HTTP file-bridge

**关键 API**: `chrome.runtime.connectNative("com.babata.host")` / `sendNativeMessage`

文档: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

**Manifest 各 OS 路径** (host name `com.babata.host`):
- macOS user: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.babata.host.json`
- macOS Edge user: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.babata.host.json`
- Linux user: `~/.config/google-chrome/NativeMessagingHosts/com.babata.host.json`
- Windows: 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.babata.host` 指 manifest

**JSON manifest schema**:
```json
{
  "name": "com.babata.host",
  "description": "babata native bridge",
  "path": "/usr/local/bin/babata-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<extension-id>/"]
}
```

**stdio 协议**: 4-byte length prefix (native byte order, 实际 little-endian on x86/arm64) + JSON UTF-8 body. 扩展→host 单消息 ≤64MB, host→扩展 ≤1MB.

**Trade-off vs HTTP file-bridge (loopback :18791)**:

| 维度 | nativeMessaging | HTTP loopback |
|---|---|---|
| 端口暴露 | 无 (stdio) | :18791 全机器可见 |
| 跨机器 (Tailscale) | 不支持 (host 跟 Chrome 绑) | 支持 (TS IP + auth) |
| 进程生命周期 | 扩展 connect 时 spawn, port close 时 kill | 独立 launchd, 跟 Chrome 解耦 |
| 安装 | 各 OS manifest + 自动找到 | launchd plist + 端口配置 |
| 多实例 | Chrome 重启自动重 spawn | 共享一个进程 |

**babata-sidebar 用法**: **双通道**. 默认 nativeMessaging (零端口暴露), 用户开启"远程模式" (Tailscale 跨机) 时切 HTTP loopback (要带 Bearer token + 仅监听 100.x Tailscale IP).

---

## 7. declarativeNetRequest

**关键 API**: 静态 `manifest.declarative_net_request.rule_resources[]` (JSON 文件) / 动态 `chrome.declarativeNetRequest.updateDynamicRules({addRules, removeRuleIds})`

文档: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest

- **action 类型**: `block` / `allow` / `redirect` / `upgradeScheme` / `modifyHeaders` / `allowAllRequests`.
- **redirect 三种**: `url` (固定) / `extensionPath` (扩展内资源) / `transform` (改 host/path/query) / `regexSubstitution` (正则替换, 配 `regexFilter`).
- **modifyHeaders**: `requestHeaders` / `responseHeaders` 数组, 每个 `{header, operation: "set"|"append"|"remove", value}`.
- **替换 .vtt URL 例 (动态)**:
```json
{
  "id": 1, "priority": 1,
  "action": { "type": "redirect", "redirect": {
    "regexSubstitution": "https://babata-cdn.local/proxy?u=\\0"
  }},
  "condition": {
    "regexFilter": "^https://.*\\.youtube\\.com/.*\\.vtt.*",
    "resourceTypes": ["xmlhttprequest"]
  }
}
```
- **配额**: 静态规则 30000 条上限 (enabled rulesets), 动态规则 5000 条 (`MAX_NUMBER_OF_DYNAMIC_RULES`), session 5000.

**babata-sidebar 用法**: 动态规则跑时. 翻译字幕场景: 监听 .vtt 重定向到本地 SW 解析; 反检测场景: `modifyHeaders` 加自定义 UA / 改 `Accept-Language`.

---

## 8. webNavigation

**关键 API**: 监听 `chrome.webNavigation.on{BeforeNavigate,Committed,DOMContentLoaded,Completed,ErrorOccurred,CreatedNavigationTarget,ReferenceFragmentUpdated,HistoryStateUpdated,TabReplaced}`

文档: https://developer.chrome.com/docs/extensions/reference/api/webNavigation

- **vs `chrome.tabs.onUpdated`**: tabs.onUpdated 只暴露 `loading` / `complete` 状态变化粗粒度; webNavigation 区分 frame / 阶段 / 类型. 想知道 frameId / parentFrameId 必须 webNavigation.
- **SPA 路由变化 = `onHistoryStateUpdated`** (history.pushState / replaceState 触发) + `onReferenceFragmentUpdated` (#hash 变化). 普通跳转走 `onCommitted` → `onCompleted`.
- **frame 范围**: 大部分事件覆盖所有 frame (含 iframe), 用 `frameId === 0` 判主 frame. `onCreatedNavigationTarget` / `onTabReplaced` 只主 frame.

**babata-sidebar 用法**: 翻译/agent 监听 `onCompleted` (普通页) + `onHistoryStateUpdated` (YouTube/X/Linear 等 SPA), `frameId === 0` 过滤主 frame.

---

## 9. storage API

**关键 API**: `chrome.storage.{local,sync,session,managed}.{get,set,remove,clear}`

文档: https://developer.chrome.com/docs/extensions/reference/api/storage

| area | 容量 | 持久 | 同步 | 适合 |
|---|---|---|---|---|
| local | 10MB (Chrome 114+, 早 5MB) / `unlimitedStorage` 无限 | 磁盘, 跨重启 | 否 | 聊天历史, 配置, MCP 缓存 |
| session | 10MB (Chrome 112+, 早 1MB) | 内存, 扩展 reload/重启清 | 否 | streaming state, 临时 token, 当前 sessionId |
| sync | 100KB total / 8KB per item / 120 ops/min | 磁盘 + Google 账户同步 | 跨设备 | 太小不实用 |
| managed | (策略下发) | 磁盘 | 否 | 企业部署 |

- **session 是 per-extension 不是 per-tab** (跟 web `sessionStorage` 不同语义, 别混).
- **大数据用 IndexedDB**: 聊天 attachment / 模型缓存 / 嵌入向量都比 storage 适合, SW 内 `indexedDB` 直接可用.

**babata-sidebar 用法**: `local` 存配置 + 聊天索引 (IDs + 元数据); `session` 存 streaming token + 当前 active sessionId; IndexedDB (Dexie 套层) 存完整聊天 body + attachment. 申请 `unlimitedStorage` permission.

---

## 10. CSP 与 connect-src

**关键字段**: `manifest.content_security_policy.extension_pages` / `sandbox`

文档: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy

- **MV3 默认**: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` — `unsafe-eval` / 远程脚本一律拒.
- **可加不可减**: 必须保留 `'self'` + `'wasm-unsafe-eval'` 等 minimum, 不能放宽到 `unsafe-eval` / 远程 CDN.
- **connect-src**: 默认未限 (除非自己写). 写了就只允许列出的 origin. 显式列推荐:
```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' http://127.0.0.1:18791 ws://127.0.0.1:18791 wss://api.anthropic.com https://api.anthropic.com https://*.babata.icu;"
  }
}
```
- **HTTP loopback**: `http://127.0.0.1:*` / `ws://127.0.0.1:*` MV3 显式允许 (不算 mixed content), 不需要 HTTPS.
- **sandbox pages**: 单独 CSP, 允许 `unsafe-eval` (用例: 跑用户提供的代码, 但 sandbox 内无 chrome.* API).

**babata-sidebar 用法**: 显式列 `connect-src`, 包含 `127.0.0.1` (file-bridge fallback) + Anthropic / OpenAI / OpenRouter API + babata.icu. 默认不留 sandbox page.

---

## 11. externally_connectable

**关键字段**: `manifest.externally_connectable.{ids, matches, accepts_tls_channel_id}`

文档: https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable

- **不写 = 默认其他扩展可连, 网页不可连**. 写了就只这白名单可连.
- **`matches`**: 网页 origin 模式, 例 `["https://babata.icu/*", "https://*.babata.icu/*"]`. 不接受通配 `<all_urls>`.
- **`ids`**: 其他扩展 ID 数组. 写了 matches 还想保留扩展互通要显式写 `"ids": ["*"]`.
- **接收事件**: 网页用 `chrome.runtime.sendMessage(extId, msg)` → 扩展 SW `chrome.runtime.onMessageExternal`; `chrome.runtime.connect(extId)` → `onConnectExternal`.

**babata-sidebar 用法**: `matches: ["https://babata.icu/*"]` 让官网"打开 babata"按钮直接 `chrome.runtime.sendMessage(extId, {open: true, prompt: "..."})`, SW 收到 + 触发 sidePanel.open + 注入 prompt.

---

## 12. chrome.identity OAuth

**关键 API**: `chrome.identity.launchWebAuthFlow({url, interactive, abortOnLoadForNonInteractive, timeoutMsForNonInteractive})` / `getRedirectURL(path?)`

文档: https://developer.chrome.com/docs/extensions/reference/api/identity

- **`getAuthToken`**: 仅 Google OAuth, 需要 manifest `oauth2` 字段. 不用.
- **`launchWebAuthFlow`**: 通用 OAuth, 弹窗到 provider. 完成后 redirect 到 `https://<extension-id>.chromiumapp.org/<path>` 即终止 + 把最终 URL 回调给扩展.
- **PKCE 流程 (Anthropic)**:
  1. SW 生成 `code_verifier` + `code_challenge`
  2. `launchWebAuthFlow({url: authUrl + redirect_uri=getRedirectURL("/cb") + code_challenge, interactive: true})`
  3. 收到 `https://<id>.chromiumapp.org/cb?code=xxx`, 提取 code
  4. SW fetch token endpoint POST `code + code_verifier` 换 access_token
  5. 存 `chrome.storage.local` (token + refresh_token)
- **限制**: 单次 flow 最长 5min (默认), URL 长度无文档明确 cap (实测 2KB+ 可).

**babata-sidebar 用法**: Anthropic OAuth (Claude Console 自助签发) 走 PKCE; 自建 babata.icu OAuth 同模式. token 存 `local`, refresh 失败重新 launchWebAuthFlow.

---

## 13. 内容安全 & 隔离

**关键字段**: `host_permissions` / `permissions: ["activeTab"]` / `optional_host_permissions` / sandbox pages

- **`host_permissions`**: 显式列要长期 fetch / 注入的 origin (e.g. `["https://*.anthropic.com/*"]`). 安装时一次性请求.
- **`activeTab`**: 临时权限, 用户点 action / commands 触发后给当前 tab 一次性访问 (无需 host_permissions). 适合"按需操作当前页"场景.
- **`optional_host_permissions`**: 运行时 `chrome.permissions.request` 动态申请.
- **sandbox pages**: `manifest.sandbox.pages: ["sandbox.html"]`, 内不能用 chrome.* API, 但可 `unsafe-eval`. 跑用户脚本 / 第三方代码必备.
- **scripting + activeTab vs host_permissions**: `chrome.scripting.executeScript` 需要任一: target tab 在 `host_permissions` / `activeTab` 已激活. 临时操作 (翻译当前页) 用 activeTab 减少安装权限震慑.

**babata-sidebar 用法**: 安装权限最小化 — `host_permissions` 只列固定 origin (Anthropic / OpenAI / babata.icu); 任意网页的翻译 / agent 走 `activeTab`; 不开 sandbox page (无该需求).
