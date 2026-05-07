# Claude in Chrome 1.0.70 反编译笔记

## 总览

这是一个 **Anthropic Computer Use 在浏览器侧的 thin client**: 模型推理 / agent loop 不在扩展跑, 而是 sidepanel.js 直连 `api.anthropic.com` 走 OAuth (含 `betas: ["oauth-2025-04-20"]`); 扩展只负责 (1) **CDP 执行 computer-use action** (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Page.captureScreenshot`), (2) **页面 a11y tree 序列化** 给模型 "看", (3) **三路远程入口** (sidepanel UI / 自家 Claude.ai 网站 externally_connectable / 桌面 App native messaging / `wss://bridge.claudeusercontent.com` cloud bridge), 四路收敛到同一个 tool dispatch 函数 `jn / handleToolCall`. 工程上有两条 1000x AI 不需要但当下必备的 crutch: offscreen document **专门用来 keep service worker alive** 防 30s idle kill, 还有 phantom cursor + glow border 让人类知道 "是 AI 在动鼠标"。

---

### 1. A11y tree content script 的实现方式

**文件**: `assets/accessibility-tree.js-DxrE0N5Q.js` (6.7KB, all_urls + all_frames + document_start), 由 sidepanel `chrome.scripting.executeScript` 调用 `window.__generateAccessibilityTree(filter, depth, maxChars, refId)`.

**关键代码** (a11y tree 完全 DOM 自拼, **不**调 CDP `Accessibility.getFullAXTree`):
```js
// accessibility-tree.js:1
window.__claudeElementMap||(window.__claudeElementMap={}),
window.__claudeRefCounter||(window.__claudeRefCounter=0),
window.__generateAccessibilityTree=function(e,t,r,i){
  // h(): tag → role 映射 (a→link, button→button, h1-6→heading, ...)
  // m(): 计算 accessible name (aria-label > placeholder > title > alt > label[for] > textContent slice 100)
  // g(): 敏感字段检测 (input[type=password/hidden] / autocomplete=cc-* / one-time-code) → "[value redacted]"
  // _(): 递归遍历, ref_id = WeakRef 到 element, 只保留 viewport 内可见可交互
  // 输出格式: 缩进文本 + role + "name" + [ref_X] + href= + type= + placeholder=
}
```

调用方 (`mcp.js:6259-6269`) 通过 `chrome.scripting.executeScript({ target: { tabId }, func: () => __generateAccessibilityTree(...) })` 把整棵树拉回, 默认 `maxChars=50000`, 超了报 error 让 LLM 缩 depth/refId. **跨 iframe**: manifest `all_frames: true` 让脚本在每帧都注入,但 `__claudeElementMap` 是每帧自己一份, 跨 iframe 引用要靠 `tabId` + frame 维度 (代码里没看到统一 frame map, 估计只对顶 frame 工作).

**剪枝策略**: `b()` 过滤函数: `aria-hidden=true` 排除 / `display:none|visibility:hidden|opacity:0|0×0` 排除 / 不在 viewport 矩形里排除 (除非 `filter='all'`) / `<script><style><meta>` 永远排除 / 必须是可交互 OR 有 role OR 有非空 name. PII 守门: 密码框 / 信用卡字段直接 redact `[value redacted]`.

**babata-sidebar 借鉴/抄/不抄**: **抄 pattern, 不抄代码**. WeakRef + ref_id 方案非常优雅; 序列化格式 `role "name" [ref_X]` 比 JSON AXNode 紧凑 50%+. Babata 自己重写一份 (~150 行), 加上对中文页面 (e.g. 微博/小红书) 的 role 推断 fallback.

---

### 2. Service worker / agent loop 主体不在 SW

**文件**: `assets/service-worker.ts-gaAAsstG.js` 只有 948 行 (prettified), **没有 agent loop**, 只做路由: `EXECUTE_TASK` / `STOP_AGENT` / `OFFSCREEN_PLAY_SOUND` / `pairing_confirmed` 等消息分发, 调度 alarms (`prompt_*` cron), 启动 sidepanel.

Agent loop 在 **sidepanel.js (2.07MB)** 里, 拉 a11y tree → 包装成 messages → 调 `anthropicClient.beta.messages.create({ model, max_tokens, betas: ["oauth-2025-04-20"], tools: [...] })`, **流式收 `tool_use` block** (mcp.js:8600-8740 streaming parser, 处理 `content_block_delta` / `text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta` / `stop_reason`), 然后调 `processToolResults` (mcp.js:11774) 串行执行每个 tool, 把 `tool_result` 接进 messages 再调一次 `messages.create`. **没有显式 MAX_TURNS 上限** — 由 `stop_reason: end_turn` 自然终止. ReAct = "标准 Anthropic tool_use 循环", 没有 thinking-then-act 显式分阶段, 但有 `thinking_delta` 流(extended thinking).

**Recover**: 单 tool 错走 `tool_result.is_error=true` 让模型自决重试; CDP `debugger is not attached` 错会 `await this.attachDebugger(e)` 后重试 sendCommand (mcp.js:2305-2311).

**babata-sidebar 借鉴/抄/不抄**: **抄 loop pattern**. 我们走 CC SDK / claude-agent-sdk 时 loop 框架自动有, 不用自己写; 但 sidepanel 走 web 时这个最小循环 (~50 行) 值得照抄思路.

---

### 3. Offscreen document 的真实用途 — Keep SW alive

**文件**: `offscreen.html` + `offscreen.js` (20KB)

**关键代码** (mcp.js:5360-5370):
```js
await chrome.offscreen.createDocument({
  url: "offscreen.html",
  reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
  justification: "Keep service worker alive, play notification sounds, generate GIFs",
});
```

**最关键** (offscreen.js:9-13):
```js
// SW keepalive — offscreen docs aren't subject to MV3's 30s idle kill.
// A message every 20s resets the SW's idle timer, keeping the bridge WS
// setInterval ping running under background throttle/freeze.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
}, 20_000);
```

明文写出意图: offscreen 不受 MV3 30s idle kill, 20s 一次 ping 让 SW 保活, 这样 `wss://bridge.claudeusercontent.com` 的 setInterval ping 不会断. 第二用途: 真生成 GIF (`gif.js` workers + canvas + click/drag/label overlay 绘制) 和真放 audio. WSS 连接本身在 SW 里 (`qa = new WebSocket(...)`, mcp.js:10750), offscreen 只负责保活.

**babata-sidebar 借鉴/抄/不抄**: **抄保活技巧, 不抄 GIF**. Babata 浏览器扩展若有长连 WSS / 远程入口 必须用同样手法. GIF generation 用不到, 删。

---

### 4. Pairing protocol — Custom WSS handshake, 非 OAuth `launchWebAuthFlow`

`pairing.html` 嵌 React, 入口 `pairing-DgNGmjV1.js` 读 URL params `request_id / client_type / current_name`, 用户点 Confirm 后发 `chrome.runtime.sendMessage({type: "pairing_confirmed", request_id, name})`.

SW 收到后 (mcp.js:11075-11099) 把 `pairing_response` 发到 bridge WSS:
```js
hn({ type: "pairing_response", request_id: t, device_id: e, name: o });
```

而 pairing **请求**是从 bridge 推下来的 (mcp.js:10936-10957):
```js
case "pairing_request":
  // 拿 request_id / client_type, 调 chrome.tabs.create 打开 pairing.html?request_id=...
```

**OAuth** 走另外一条路 (perm.js:1712-1736 + 4282-4310):
- `AUTHORIZE_URL: "https://claude.ai/oauth/authorize"`, `TOKEN_URL: "https://platform.claude.com/v1/oauth/token"`
- `CLIENT_ID: "dae2cad8-15c5-43d2-9046-fcaecc135fa4"` (production)
- `SCOPES: "user:profile user:inference user:chat"` (注意 `user:inference` — OAuth 拿到的 token 直接用来调 `messages.create`, 不需要 API key!)
- `chrome.identity.launchWebAuthFlow({ url, interactive: true })`, PKCE S256, redirect_uri 是 `chrome-extension://<id>/oauth_callback.html`
- 也支持 `claude.ai` 网页直接发 `oauth_redirect` 消息 (sw.js:929 onMessageExternal handler) 拿到 token

Token 存 `chrome.storage.local` 的 `accessToken / refreshToken / tokenExpiry / accountUuid`. 设备 id 持久化在 `bridgeDeviceId` (UUID, 首次随机生成).

**babata-sidebar 借鉴/抄/不抄**: **抄 OAuth flow + scopes 思路, 不抄 bridge pairing**. Babata 不需要 cloud session pairing, 直接走 OAuth 拿 inference scope 是关键 — 用户不用提供 API key. 但要查 `user:inference` scope 是不是 Anthropic 公开给第三方扩展的 (估计是 first-party only, 我们要走 API key + OAuth desktop flow 两条路并行).

---

### 5. Native messaging host = Claude desktop app 自家进程

**Manifest**: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.anthropic.claude_browser_extension.json`
```json
{
  "name": "com.anthropic.claude_browser_extension",
  "path": "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/",
    "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",
    "chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/"
  ]
}
```

**Binary**: `chrome-native-host` (2.1MB Mach-O universal), Rust 写的 (binary 里看到 `tokio-1.47.1`, `rustc/e408947`, 用 logger_rs). Strings 给出协议:
- 启动后开 Unix socket: `claude-mcp-browser-bridge-<uid>` 监听 MCP client 连接 (`Socket server listening for connections`)
- 双向 forward: Chrome stdio ↔ MCP clients (`MCP client X connected`, `Forwarding tool request from MCP client X`, `Forwarding tool response to N MCP clients`)
- 消息类型: `ping/pong`, `get_status` → `status_response{native_host_version: "0.1.0", ...}`, `tool_request{method, params}`, `tool_response`, `notification`, `mcp_connected`, `mcp_disconnected`

**作用**: Claude Desktop App / Claude Code 通过 Unix socket 接 native host, host 用 stdio 转发到扩展, 扩展替它在浏览器里执行 tool calls (browser as MCP server). 三个 extension id allowed: dihbg... (dev), fcoeo... (prod = V 这个), dngcp... (估计 staging). SW 启动时 `chrome.runtime.connectNative("com.anthropic.claude_browser_extension")` (sw.js:64) ping 测试连通.

**babata-sidebar 借鉴/抄/不抄**: **架构抄一半**. babata 自己有 desktop CC, 完全可以写一个等价的 native host 让本地 CC 把 browser tool 暴露出来。但 babata 设计上 CC 已经能调 web-access skill, native host 是冗余。**结论**: 不实现, 等真有 "本地 agent → 浏览器执行" 用例再做。

---

### 6. Visual indicator — 三层 UI (cursor + glow + stop button + static pill)

**文件**: `assets/agent-visual-indicator.js-CQ3yeUso.js` (16.9KB, all_urls document_idle, **all_frames: false** 只顶 frame)

**4 个组件全 inline DOM 注入** (无 Shadow DOM, 用 `id="claude-*"` 防冲突, `z-index: 2147483646/7`):
- **Phantom cursor** (id=`claude-phantom-cursor`): SVG 鼠标指针, 走 `translate3d` + `transition: transform 180ms cubic-bezier(0.2, 0, 0, 1)`, 配色 `#D97757` (Claude 橙) + `drop-shadow` glow. 跟随 `UPDATE_PHANTOM_CURSOR` message 移动 (跟 CDP `Input.dispatchMouseEvent` 联动, mcp.js:2344).
- **Glow border** (id=`claude-agent-glow-border`): 全屏 inset box-shadow 橙色脉冲, `@keyframes claude-pulse 2s ease-in-out infinite`, opacity 0.3s 渐入渐出.
- **Stop button** (id=`claude-agent-stop-button`): 底部居中, "Stop Claude" 文案, click 发 `STOP_AGENT` 给 SW.
- **Static indicator pill**: tab group 还活着但当前 tab 不是 main 时显示, "Claude is active in this tab group" + 跳回 main + dismiss button. 走 5s heartbeat (`STATIC_INDICATOR_HEARTBEAT`) 自检.

**消息协议** (chrome.runtime.onMessage):
- `SHOW_AGENT_INDICATORS` / `HIDE_AGENT_INDICATORS` (整体)
- `UPDATE_PHANTOM_CURSOR { x, y }` (高频)
- `HIDE_FOR_TOOL_USE` / `SHOW_AFTER_TOOL_USE` (截图前临时藏起来防自拍, mcp.js:2384-2386 + 1300)
- `SHOW_STATIC_INDICATOR` / `HIDE_STATIC_INDICATOR` (heartbeat 失败时)

**坑**: 没用 Shadow DOM, 选择器纯 `id` + 行内 `style.cssText` 全量赋值, 容易被页面 CSS 用 `*[id^=claude-]` 选中污染。AudioContext 提前创建是为了 unlock autoplay (`r = new AudioContext; gain.value=0; constantSource.start()`, agent-visual-indicator.js:1).

**babata-sidebar 借鉴/抄/不抄**: **抄 phantom cursor + glow border + stop button 全套, 但用 Shadow DOM 重做**. Static indicator + heartbeat 这套 tab group 复杂度对 babata 不必要 (我们没 tab group). 直接照抄 SVG 鼠标 d 属性 + 颜色 (橙 #D97757 改成 babata 自己色)。

---

### 7. chrome.debugger CDP 实战 — 极简集

**用到的 CDP 方法** (grep `sendCommand`, mcp.js):
- `Runtime.enable` / `Runtime.evaluate` (执行 page-side JS, 用于读 scrollX/Y, mcp.js:4675)
- `Page.enable` / `Page.captureScreenshot` (mcp.js:2728, 3908) / `Page.handleJavaScriptDialog` (mcp.js:2157, 处理 beforeunload)
- `Network.enable { maxPostDataSize: 65536 }` (mcp.js:2252, optional 网络追踪)
- `DOM.enable` / `DOM.setFileInputFiles` (mcp.js:4690, 上传文件)
- `Input.dispatchMouseEvent` (mcp.js:2374, 全部点击/拖拽/滚轮)
- `Input.dispatchKeyEvent` (mcp.js:2378)
- `Input.insertText` (mcp.js:2381, 多语言 IME-safe 输入)

**没用到** Accessibility.getFullAXTree (a11y 走 page DOM 自拼) / Target.* / Browser.* / Emulation.*. 路径很 minimum, 不去碰 internal CDP.

**Attach 时机** (mcp.js:2202-2259): 第一次 sendCommand 前 lazy attach, `chrome.debugger.attach(t, "1.3", ...)` (CDP version 1.3), 30s timeout, 失败抛 `debugger_attach_error: ... DevTools may be open on this tab`. **Detach**: tab close / agent stop. 黄色警告条 ("Claude started debugging this browser") **没找到任何代码隐藏**, 估计就让它显示, 当 "Claude 在控制" 的 disclosure (跟 visual indicator 互补).

**Fallback**: scroll action 有 CDP scroll → `chrome.scripting.executeScript` 的退路 (mcp.js:3683 — 当 CDP scroll ineffective 时切 scripting), 别的 action 没 fallback.

**babata-sidebar 借鉴/抄/不抄**: **抄方法选择 + attach 容错代码**. `Input.dispatch*` + `Page.captureScreenshot` + `DOM.setFileInputFiles` 这套就是 web agent 的最小可用集。可惜 chrome.debugger 这个 permission 触发警告条 + Chrome Web Store 审核风险高,babata 估计要走 CDP via DevTools Protocol over WebSocket (`http://localhost:9222`) 而不走 chrome.debugger,牺牲打包扩展的体验换无警告。

---

### 8. Bridge WSS — Anthropic cloud session manager

**Endpoint**: `wss://bridge.claudeusercontent.com/chrome/{oauth_token}` (mcp.js:10748)

**握手** (mcp.js:10754-10765): WS open 后立刻发:
```js
{ type: "connect",
  client_type: "chrome-extension",
  device_id: <persistent UUID>,
  os_platform: <mac/win/linux>,
  extension_version: "1.0.70",
  display_name: <user-edit>,
  // 注意:bridge.claudeusercontent 走 path 里塞 token, 不再 connect 里发 oauth_token
}
```

**消息类型** (mcp.js:10772-10970 dispatch):
- inbound: `paired` (配对成功) / `waiting` (排队等 peer) / `peer_connected` / `peer_disconnected` / `tool_call { tool, args, tool_use_id, target_device_id, client_type, permission_mode, allowed_domains, handle_permission_prompts, session_scope }` / `pairing_request { request_id, client_type }` / `permission_response { request_id, allowed }` / `ping` / `pong` / `error`
- outbound: `connect` (上面那条) / `pong` / `tool_result { tool_use_id, content / error }` / `pairing_response { request_id, device_id, name | dismissed }` / `permission_request` / `ping` (20s 一次, mcp.js:10729-10732)

**保活/重连**: 20s 一次 ping; 90s 没 pong 主动 close(4001, "pong-timeout") (mcp.js:11060-11066); close 后 exponential backoff (`Wa` reconnect_attempt 计数, `Va` 1008 close 次数, 连续 2 次 1008 清 ACCESS_TOKEN, mcp.js:10987-10995). Code 1008 = "Policy Violation", 估计是 token 过期。

**作用**: Claude.ai 网页 / Claude Desktop / 别的 Claude 客户端 用同一 user 的 token 连进来 → bridge 把 tool_call 推给配对的 chrome extension 执行。本质是 cloud-side multi-device session orchestrator, agent 在哪都可以指挥浏览器。

**babata-sidebar 借鉴/抄/不抄**: **不抄整体, 借鉴 keepalive + reconnect 模式**. babata 通讯层已经有 `wss` 连接经验 (TG bot poll / WeChat ilink), websocket+exponential backoff+pong 超时主动 close 是范本。但 cloud bridge 这层对 babata 是 over-engineering — 我们的桥是 babata 内核 (CC SDK), 不需要 cloud, 走 native messaging 或 unix socket 就够。

---

### 9. Storage / state — chrome.storage.local 单源, 全列表

**46 个 storage key** (perm.js:2163-2202):
```
ACCESS_TOKEN / REFRESH_TOKEN / TOKEN_EXPIRY / OAUTH_STATE / CODE_VERIFIER / LAST_AUTH_FAILURE_REASON / ACCOUNT_UUID
ANTHROPIC_API_KEY  // 也支持纯 API key 模式
SELECTED_MODEL / SELECTED_MODEL_QUICK_MODE / SYSTEM_PROMPT / PURL_CONFIG
DEBUG_MODE / MODEL_SELECTOR_DEBUG / SHOW_TRACE_IDS / SHOW_SYSTEM_REMINDERS / PERF_TRACE_PILL
USE_SESSIONS_API / SESSIONS_API_HOSTNAME
BROWSER_CONTROL_PERMISSION_ACCEPTED / PERMISSION_STORAGE / LAST_PERMISSION_MODE_PREFERENCE
ANONYMOUS_ID / SCHEDULED_TASK_LOGS / SCHEDULED_TASK_STATS / PENDING_SCHEDULED_TASK
TARGET_TAB_ID / UPDATE_AVAILABLE / TIP_DISPLAY_COUNTS / NOTIFICATIONS_ENABLED / ANNOUNCEMENT_DISMISSED / MODEL_OVERRIDE_SEEN
SAVED_PROMPTS / SAVED_PROMPT_CATEGORIES  // ← cron / scheduled task data
TAB_GROUPS / DISMISSED_TAB_GROUPS / MCP_TAB_GROUP_ID / MCP_CONNECTED / QUICK_MODE_TIP_DISMISSED
bridgeDeviceId / bridgeDisplayName  // bridge identity
```

全走 `chrome.storage.local`, **没用 `chrome.storage.session` 也没用 IndexedDB** (gif.js 用 worker 但产物直接 base64). SW 重启后 hydrate: `await initialize()` (sw.js:392 启动时 + 每个 listener 入口都 await), 拉 `TAB_GROUPS` 重建 `tabGroupsManager` 的 in-memory `groupMetadata` Map.

**Tab group 状态机**: 每个 group 有 `chromeGroupId` + `memberStates: Map<tabId, {indicatorState: "pulsing"|"static"|"none"}>` + `mainTabId`, **存 storage 里的是 plain JSON**, manager 在内存里维护 Map. main tab 关掉时自动 regroup 到现有 tab (mcp.js:456-490).

**babata-sidebar 借鉴/抄/不抄**: **抄 storage key naming + 分类**. babata 浏览器扩展会有类似但更少的 key (~10 个). PERMISSION_STORAGE 域名级权限对所有浏览器扩展通用, 抄。SAVED_PROMPTS (定时任务) 跟 babata cron 重叠, babata 走自己 cron 不需要扩展自带。

---

### 10. Content script ↔ SW 通信 — 一次性 sendMessage 为主, 极少 Port

**协议**: 全用 `chrome.runtime.sendMessage` (一次性) / `chrome.tabs.sendMessage(tabId, ...)` (定向) + `sendResponse` 异步, **基本不用 `chrome.runtime.connect` Port** (Port 主要给 native messaging 用, sw.js:64).

**消息类型命名** (大写下划线 SCREAMING_CASE 主流):
- agent control: `STOP_AGENT` / `EXECUTE_TASK` / `EXECUTE_SCHEDULED_TASK` / `OPEN_OPTIONS_WITH_TASK` / `POPULATE_INPUT_TEXT`
- side panel: `open_side_panel` / `SWITCH_TO_MAIN_TAB` / `SECONDARY_TAB_CHECK_MAIN` / `MAIN_TAB_ACK_REQUEST/RESPONSE` / `STATIC_INDICATOR_HEARTBEAT` / `DISMISS_STATIC_INDICATOR_FOR_GROUP`
- indicator: `SHOW_AGENT_INDICATORS` / `HIDE_AGENT_INDICATORS` / `UPDATE_PHANTOM_CURSOR` / `HIDE_FOR_TOOL_USE` / `SHOW_AFTER_TOOL_USE` / `SHOW_STATIC_INDICATOR` / `HIDE_STATIC_INDICATOR`
- offscreen: `OFFSCREEN_PLAY_SOUND` / `GENERATE_GIF` / `REVOKE_BLOB_URL` / `SW_KEEPALIVE`
- pairing/auth: `pairing_confirmed` / `pairing_dismissed` / `show_pairing_prompt` / `oauth_redirect` / `check_and_refresh_oauth` / `check_native_host_status` / `logout` / `SEND_MCP_NOTIFICATION`
- external (claude.ai 网页 → SW): `oauth_redirect` / `ping` / `onboarding_task` (sw.js:924-947, externally_connectable + origin 验证 `https://claude.ai`)

**关键模式**:
1. SW 永远 `return true` 表示异步 response (sw.js:842)
2. `chrome.runtime.lastError` 检查 + `.catch(() => {})` 静默吞错 (常见, 因为 content script 可能在 chrome:// 页面缺失)
3. content script 注入失败 fallback: `chrome.tabs.sendMessage(...).catch(() => {})` 后继续走 (mcp.js:2351)

**babata-sidebar 借鉴/抄/不抄**: **抄 SCREAMING_CASE 命名 + return true 异步模式**, 但用更少的 message type. Anthropic 这套 30+ 个 message type 是 5 个 entry point (sidepanel/options/pairing/content-script/native-host) 各自演化的产物, babata 单一 sidepanel + content script + native messaging 三入口能压到 ~12 个 type.

---

## 附录: 关键内部函数命名 (压缩字母 → 推测语义)

`mcp.js`:
- `B` = TabGroupsManager (initialize, findGroupByTab, createGroup, dismissStaticIndicatorsForGroup)
- `H` = CDPHelper (attachDebugger, sendCommand, dispatchMouseEvent, click, type, screenshot)
- `j` = static state singleton (debuggerListenerRegistered, beforeunloadPolicyByTab, ...)
- `qa` = bridge WebSocket instance, `Qa()` 拿 displayName, `rn()` 拿 deviceId
- `jn` = handleToolCall (dispatch tool 名 → 各 case)
- `Pa` / `Ua` = tool result formatter (text/image content blocks)

`perm.js` 主要是 React UI + auth + analytics segmentation.

`sw.js`: `R/U` = native messaging connect/disconnect, `O` = onMessage handler, `D` = post tool_response, `t` = tabGroupsManager 引用 (从 mcp.js 导入).
