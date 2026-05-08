# AI Chat 浏览器扩展 深度调研 (6 个开源对标库)

## 调研目标

V 拍板"集百家之所长". 翻译方向已经在 `research/02-immersive-translate.md` + `reference_translate_open_source_4_repos.md` (4 个翻译扩展) 里 cover. 这份补 **chat / agent / sidebar** 这另一半 — babata-sidebar 同时是聊天产品 + page agent + 浏览器管家, 不能只看翻译。

筛选标准: 高 star (>500) + 活跃 (近 6 月有 push) + TS/JS 主栈 + 跟 babata-sidebar 学习目标差异化 (chat UX / multi-model / multi-agent / page automation / 浏览器内 LLM 五个维度各取标杆).

## 6 个对标库一表

| repo | star | 类型 | 推送 | 核心特征 | 跟 babata 关系 |
|------|-----:|------|------|----------|----------------|
| [page-assist](https://github.com/n4ze3m/page-assist) | 7.9k | sidebar 标杆 | 2026-05-03 | Ollama-first + WXT + chrome.sidePanel + Dexie | UX 模板, 抄 lifecycle sentinel + Dexie schema |
| [chathub](https://github.com/chathub-dev/chathub) | 10.6k | multi-bot 比较 | 2026-02-27 | Abstract bot event stream + Jotai atom + Proxy Tab CORS | 抄 bot 抽象 + cookie 复用 |
| [nanobrowser](https://github.com/nanobrowser/nanobrowser) | 12.9k | multi-agent 自动化 | 2025-11-24 | Navigator+Planner 双 agent + index-based 元素 + 截图+bbox | 抄 selectorMap + isNew diff (但跳过 LangChain) |
| [browserbee](https://github.com/parsaghaffari/browserbee) | 972 | "Cline for web" | 2025-10-22 | playwright-crx + per-window state + tool-sequence replay | 抄 per-window state + memory replay (跳过 12k 上限) |
| [web-llm-chat](https://github.com/mlc-ai/web-llm-chat) | 1.0k | 浏览器内 LLM | 2026-02-18 | @mlc-ai/web-llm + SW/Worker 双引擎 + IndexedDB cache | **不集成** (cloud-first 更优), 仅留 SW/Worker pattern 备用 |
| [browseros-agent](https://github.com/browseros-ai/BrowserOS) | 10.8k | agentic 浏览器 fork | 2026-05-08 | 53 tools / 7 categories + ai SDK ToolLoop + Zod registry | 抄 unified registry + MCP 暴露 (扩展 cap 接受) |

clone 公共空间: `~/code/ai-extension-references/` (跟 `~/code/translate-references/` 同模式), 总 ~170MB (browseros 138MB sparse 占大头).

---

## 一、page-assist (7.9k★) — Ollama-first sidebar

### 架构

WXT framework (manifest 由 wxt.config 派生) + React + Ant Design + Dexie. 用 `chrome.sidePanel` 原生 API 不靠 content script overlay. Service worker `persistent: true` 是 WXT intent flag 不真保活 — 真保活靠 Dexie 重建.

**Multi-model 抽象** (`/src/models/index.ts:16-259`): 一个 `pageAssistModel()` 函数 switch 到 LangChain 各 vendor class:
- `chrome::gemini-nano` → ChatChromeAI (line 81)
- `gemini` → ChatGoogleAI (line 115)
- `anthropic` → ChatAnthropic (line 132)
- `openrouter` → CustomChatOpenAI (line 143)
- `ollama2` → ChatOllama 全参数 spread (line 169-207)
- fallback → CustomChatOpenAI (line 209)

无 adapter pattern, 直接 LangChain 实例化. Ollama 走 spread 不归一化 — "让后端决定 valid 与否".

### Page 上下文抽取

`/src/libs/get-tab-contents.ts:46-111`: `browser.scripting.executeScript()` 拿 `document.documentElement.outerHTML`, 然后:
- 站特化 parser: YouTube (YtTranscript), Wikipedia, Amazon, Twitter, PDF
- fallback: **Defuddle** library (`/src/parser/default.ts:1`) HTML→markdown
- 再 fallback: DOM 手洗 (剥 script/style/aria-hidden, 优先 `[role="main"]`/`main`/`article`)
- 硬上限 `maxWebsiteContext` 默认 4028 字符 (line 87)

embedding 走 in-memory Pinecone-style `PAMemoryVectorStore` (`useMessage.tsx:34`), 抽取后才嵌, 不预嵌.

### Streaming 流

`/src/hooks/useMessage.tsx:408`: `for await (const chunk of chunks)` 直接消费 LangChain 的 `.stream()`. 累计 `fullText`, 加 `▋` 闪烁光标. 检测 `chunk.additional_kwargs.reasoning_content` 包 `<think>` 标签 — 兼容 o1/Claude thinking.

无 port 转发, 流就在 sidepanel React 进程里跑.

### Storage schema

Dexie v1→v5 演进 (`/src/db/dexie/schema.ts:127-149`):
- `chatHistories`, `messages`, `openaiConfigs`, `customModels`, `modelState`, `providerState`, `memories`, `mcpServers` (v4+)
- 全 plaintext 不加密

### Killer 抄点

**Port-based lifecycle sentinel** (`/src/entries/background.ts:207-213`):
```ts
browser.runtime.onConnect.addListener(port => {
  if (port.name === 'pgCopilot') {
    isCopilotRunning = true;
    port.onDisconnect.addListener(() => { isCopilotRunning = false; });
  }
});
```
sidepanel 一打开就 connect, SW 就知道 UI 在线. 然后 context menu 那边 `setTimeout(send, isCopilotRunning ? 0 : 5000)` 决定是否等. babata sidepanel 跟 SW 之间也有这个 race, 抄过来.

### 必抄

1. **Port sentinel** (background.ts:207-213) — sidepanel 在线感知
2. **Dexie 版本化 schema** (db/dexie/schema.ts) — 演进路径清晰
3. **Defuddle + DOM fallback** (parser/default.ts) — 未知站点 robust 解析
4. **chunk.additional_kwargs.reasoning_content 处理** (useMessage.tsx:409) — Claude/o1 thinking 透传
5. **Ollama 参数 spread** (models/index.ts:169-207) — 不归一化, 信后端

### 必不抄

**Hardcoded 5s setTimeout** (background.ts:245-254): 5 秒是猜的, 网络/JS 阻塞会让 sidepanel 还没 ready. 作者自己留 TODO "this is a bad method". 正确做法: sidepanel mount 后显式发 "ready" 消息, SW 等到再 send.

---

## 二、chathub (10.6k★) — Multi-bot 同屏对比

### Abstract Bot 协议

`abstract-bot.ts:33-89`: 所有 bot 继承 `AbstractBot`, 核心接口 `doSendMessage(params: SendMessageParams)`. 事件流 union `UPDATE_ANSWER | DONE | ERROR` (line 9-20). 装饰器 `doSendMessageGenerator()` 把 callback 事件转成 `ReadableStream<AnwserPayload>` 让 UI 用 `for await`.

工厂: `createBotInstance(botId)` (`index.ts:34-73`).

具体实现:
- **ChatGPT (Web)** (`chatgpt-webapp/index.ts:38-150`): 复用浏览器登录态. 拿 token: `fetch('https://chat.openai.com/api/auth/session')` (`client.ts:27-37`). 流: SSE 从 `/backend-api/conversation`. **CORS fallback**: 若 extension fetch 被拦, 启动 pinned ChatGPT tab 当 proxy, 内容脚本中转 (`requesters.ts:16-88`).
- **Claude Façade** (`claude/index.ts:10-42`): 单门面 switch 4 backend (API / Web / OpenRouter / Web-access agent).
- **Claude API** (`claude-api/index.ts:18-34`): 用 deprecated `/v1/complete` + `max_tokens_to_sample` — Anthropic 已 sunset, 这块要换.

SSE 解析全部走 `utils/sse.ts:4` 单一 `parseSSEResponse`, 不重复.

### Multi-bot 同屏

`pages/MultiBotChatPanel.tsx`. State 是 Jotai atomWithStorage:
- `layoutAtom` — 2/3/4/6 grid (line 20)
- `twoPanelBotsAtom` — 哪些 bot ID 在哪格 (lines 21-24)

广播: `uniqBy(chats, c => c.botId).forEach(c => c.sendMessage(input, image))` (line 68).

### Premium gating (反面教材)

`services/premium.ts:16` + `hooks/use-premium.ts:6-28`: license key 存 `localStorage['premium']`, lemonsqueezy 验证, fallback 是 localStorage. **客户端编辑就能解锁**. multi-bot >2 panels 也是 client-side check (`MultiBotChatPanel.tsx:49-52`). 后端不验.

### i18n

`i18next` + 9 个 JSON locale (zh-CN, zh-TW, ES, PT, JA, DE, FR, ID, TH). babata 多语言场景类似可抄.

### 必抄

1. **AbstractBot event-stream protocol** (abstract-bot.ts:9-20) — `AsyncIterable<Event>` 比 Promise 干净
2. **Jotai atomWithStorage** (MultiBotChatPanel.tsx:20-24) — 多 view 持久化样板少
3. **Façade pattern** (claude/index.ts) — 一个 ClaudeBot 门面 switch API/Web/OpenRouter
4. **Proxy Tab for CORS** (requesters.ts:16-88) — pinned tab + content script 中转 cookie + CORS, 一招两解
5. **集中 SSE parser** (utils/sse.ts:4) — 各 bot 复用

### 必不抄

1. **Client-side premium gating** (premium.ts:16) — 永远不信任 localStorage, 必须服务端 gate
2. **Deprecated Claude /v1/complete** (claude-api/index.ts:18-34) — 用 `/v1/messages`, 别留这种 sunset 风险

---

## 三、nanobrowser (12.9k★) — Multi-agent web automation

### 双 Agent 拓扑

- **NavigatorAgent** (`chrome-extension/src/background/agent/agents/navigator.ts:75-85`) — 执行原子动作 (click/input/scroll/navigate)
- **PlannerAgent** (`agents/planner.ts:48-51`) — 验证 done + 给 next_steps. 周期性跑 (planningInterval, 默认每 N 步).

执行循环 (`executor.ts:128-174`):
```ts
for (step = 0; step < maxSteps) {
  if (step % planningInterval === 0) {
    planOutput = planner.execute();
    if (planOutput.done) break;
  }
  navOutput = navigator.execute();
}
```
共享状态走 `AgentContext` mutable 对象, 没有 queue/blackboard.

### Tool schema (Zod + LangChain)

`actions/schemas.ts`: `click_element`, `input_text`, `scroll_to_percent`, `done`, `go_to_url`, `search_google`, `switch_tab`, `open_tab`, `close_tab`, `send_keys`, `cache_content`, `wait`, `get_dropdown_options`, `select_dropdown_option`. `click_element` schema (line 46-54): `{intent: string, index: int, xpath?: string}`.

**不是 MCP**. 用 LangChain structured output + JSON tool calling. 适配 OpenAI/Anthropic/Google/Groq/Cerebras/DeepSeek/Ollama (LangChain BaseChatModel).

### DOM 感知 (核心 insight)

`browser/dom/service.ts:93-110`: 注入 `buildDomTree` 脚本到内容侧, 构造 `DOMElementNode` 树. 只留 interactive 元素.

`browser/dom/views.ts:68-120`: 节点带:
- `highlightIndex` — 数字 label
- `xpath` — 仅 debug log, 实际不用
- `viewport/page coordinates`
- `isNew` flag — 这步 vs 上步新出现的元素

**Vision 时**: 截图 + bounding box overlay 一起送 LLM (prompts/base.ts).

### Element 解析 (杀手锏)

**Index-based, 不是 selector-based**:
1. 感知期: `buildDomTree()` 生成 flat `selectorMap: Map<number, DOMElementNode>`. index 0..N 顺序分配.
2. 动作期: LLM 输出 `{"click_element": {"index": 42}}`. 代码 `selectorMap.get(42)`.
3. xpath 在 schema 里有但**永不真用**, 只 log.
4. **页面变化**: 在 multi-action batch 里, 用 `calcBranchPathHashSet` 哈希比较 (`actions/builder.ts:391-406`). 检测到 DOM 变 → **中断 batch, 重感知, 重计划**.

为什么有效: index 是 ephemeral, 每 step 重新生成. LLM 看到当前 indexed tree + 截图 + bbox, "click 'Login' button" 隐式靠 LLM 在 tree 里找文本匹配.

### 失败恢复

3 层:
1. Per-action: 单 batch 容 3 错, >3 抛 "Too many errors" (`navigator.ts:432-449`)
2. Per-step: `consecutiveFailures` ≥ 5 整 task abort (`executor.ts:309-312`)
3. 重感知: hash 检测 DOM 变 → 中断重来 (`navigator.ts:392-406`)

无显式 retry 循环, 错往上抛.

### 状态持久化

**没有**. `currentExecutor` 在 `index.ts:25` 模块变量, SW 重启就丢. `MessageManager` 每 task 重建. 只有 `replayHistoricalTasks=true` 时才把 `AgentStepHistory` JSON 存 `chatHistoryStore` (`executor.ts:222-228`).

implication: SW 重启 = task lost. 这是 babata 必须解决的洞.

### 必抄

1. **isNew flag** (views.ts:91) — 标新出现的元素让 planner 知道 page 变了
2. **selectorMap (index-based)** (service.ts:101-110) — dumb index + 重感知, 比 selector 鲁棒
3. **截图 + bbox overlay** (prompts/base.ts) — 视觉 + tree 双通道, 协同
4. **Zod 校验 action** (actions/builder.ts:66) — LLM 乱输出在 schema 层挡掉
5. **Multi-action batch + DOM hash detect** (navigator.ts:392-406) — 一批 10 个动作, 中途变了就拆

### 必不抄

1. **LangChain 抽象层** — V 哲学 "不压 LLM 上限". MCP-style raw provider adapter > LangChain 包装. 调试更直, 换 provider 更易.
2. **无 index 边界校验** — LLM 幻觉 index=999 max=50 时, `selectorMap.get(999)` 返 undefined, 错被推后才发现. 应该在 schema 层 `z.number().max(maxIndex)`.

---

## 四、browserbee (972★) — "Cline for web"

### 杀手设计: playwright-crx

`package.json:44`: `@parsaghaffari/playwright-crx@0.14.0` — 自家 fork. 不是浏览器内跑 Playwright, 是 **Playwright API over CDP**:
```ts
import { crx } from 'playwright-crx';
const app = await crx.start();  // 内部走 CDP
```

为什么有意义: 不重写 Cline 的 tool 循环, 直接复用 Playwright Page 抽象. 但底层就是 chrome.debugger CDP. babata V0 已用 chrome.debugger, 抄不抄 playwright-crx 看是否值得多 layer.

### Tool schema

`agent/tools/types.ts:14-17`:
```ts
interface BrowserTool {
  name: string;
  description: string;
  func: (input: string, ctx?: ToolExecutionContext) => Promise<string>;
}
```

执行期 (`ExecutionEngine.ts:258`) 用自定义 XML 3-tag:
```
<tool>tool_name</tool>
<input>arguments_here</input>
<requires_approval>true or false</requires_approval>
```
比 Cline `<tool_code>` 简单. regex 解析.

### Per-window 状态 (核心 insight)

`background/agentController.ts:49-52`:
```ts
const windowMessageHistories = new Map<number, MessageHistory>();
```
**Per-window, 不是 global, 不是 per-tab**. tab 切换不丢上下文, 但 window 切换会换 history. babata sidepanel 也是 per-window 的, 这个 mapping 直接对应.

### Memory injection (tool-sequence replay)

`MemoryManager.ts:20-52` + `tools/memoryTools.ts`: agent 第一步主动调 `lookup_memories(domain)`, 拿 IndexedDB 里之前同域的 tool 调用序列, 当 user message 注入. 不是 conversation replay, 是 **playbook replay**.

为什么聪明: 重放 tool 序列比重放对话便宜, 而且 LLM 看到的是"上次在这个域我做了 X→Y→Z", 自然推断这次也做.

### Token 管理 (硬限+滑窗)

`agent/TokenManager.ts:14-92`:
- `MAX_CONTEXT_TOKENS = 12_000` (line 15) — **太死板**, 现代模型 200k 浪费 94%
- 估算 `char/4` (line 18)
- 修剪策略: 留所有 user msg (含原 request), 删最老 assistant msg (line 35-92)
- `MAX_STEPS = 50` 硬 loop-exit (`ExecutionEngine.ts:11`)

修剪策略本身好 (保 user 意图), 但上限太低. babata 应该按 model 实际 context window 动态算.

### Privacy

- 记忆只在 IndexedDB (`tracking/memoryService.ts:15-16`) `browserbee-memories` DB
- API key 在 `chrome.storage.sync` (`configManager.ts:30`) — 浏览器加密 + 不上 ext 服务器
- Ollama 可选 — 真要本地不用云

### 必抄

1. **Per-window conversation state** (agentController.ts:49-52) — Map by windowId
2. **lookup_memories(domain) 作 first tool call** (MemoryManager.ts:20-52) — domain-specific playbook 自然演化
3. **BYOK factory** (models/providers/factory.ts:8-33) — 简洁的 createProvider switch
4. **Lazy agent init** (agentController:366-411) — 不 pre-warm, 用户首条消息才创建
5. **3-tag XML tool format** (ExecutionEngine:258) — 比 Cline 6-tag 干净

### 必不抄

1. **MAX_CONTEXT_TOKENS=12000 硬编码** (TokenManager:15) — 该 model-aware (Claude 200k, GPT-4 128k)
2. **滑窗删 oldest assistant** — 多步 task 会丢中段推理. 应改 LLM-summarization (压缩 "user 点 search → 看到 10 结果 → 选第 3 个")

---

## 五、web-llm-chat (1.0k★) — WebGPU 浏览器内 LLM

### 项目类型

**Next.js 全站 PWA, 不是扩展**. 没有 manifest.json (chrome ext). 无法直接复用为扩展, SDK `@mlc-ai/web-llm` 理论可在 MV3 用但有硬限制.

### 模型加载

不打包. 走 CDN, `prebuiltAppConfig` (`app/constant.ts:1`, `app/client/webllm.ts:47`).
- IndexedDB cache 可选 (`useIndexedDBCache`)
- 模型大小: Llama-3.2-1B-Instruct-q4f32_1 ~650MB / Llama-3.1-8B-Instruct-q4f16_1 ~4.5GB / DeepSeek-7B variants ~4-5GB
- 首次下载 5-15 min 阻塞, 但 UX 只有泛 spinner (`home.tsx:33-44`), 没进度条没取消按钮

### 双引擎 (核心 insight)

`app/client/webllm.ts:24-71`:
1. **ServiceWorkerMLCEngine** (line 53-58) — 模型在 SW, 跨 tab 关闭存活, KEEP_ALIVE_INTERVAL=5s
2. **WebWorkerMLCEngine** (line 60-68) — Worker 专跑, 主线程不卡

```ts
this.webllm = useSW
  ? new ServiceWorkerMLCEngine(...)
  : new WebWorkerMLCEngine(...);
```

Streaming 是 async generator (line 237-248), `for await chunk` 标准.

### MV3 硬限制

**WebGPU 在扩展 service worker 不可用**. SW 没 `navigator.gpu`. 唯一路径是 iframe 或 content script, web-llm 不支持开箱.

### 必抄

**双引擎 fallback pattern** — 即使不上 WebLLM, 任何"重计算 in extension"场景 (大段翻译 / embed / OCR / TTS) 都该用 SW 持久 + Worker 离主线程的二选一抽象.

### 必不抄

**Zustand persist 到 localStorage** (`utils/store.ts:36-66`) — 没 quota check (>5-10MB 静默炸), 不压缩, 不归档. babata 100+ 对话直接溢. 用 IndexedDB + cleanup job.

### 推荐: babata **不集成** WebLLM

理由 (跟 V `feedback_local_first_no_cloud` 看似冲突, 但要 calibration):
- **质量**: 2026 Sonnet/Opus $3-15/1M tokens, 1B-8B 本地差代差
- **UX 税**: 5-15 min 首次下载 + IndexedDB quota + GPU 在 MV3 SW 不可用 + 用户硬件异构 (M1/RTX/AMD)
- **维护**: WebLLM SDK 跟 Chrome GPU driver 紧耦合, 升级风险
- **甜区窄**: 只在用户离线 >50% 时间 + 10GB+ VRAM 才有意义, babata 用户场景不命中
- **跟 babata `feedback_local_first_no_cloud` 不冲突**: 那条说 babata runtime/memory/chat-archive 不上云, **不是** 模型推理本地. 模型推理走 OpenRouter/Anthropic 是 channel 走云 (跟 TG/CF tunnel 同性质), runtime 没上云.

如硬要离线: 抄双引擎 pattern, 配 1B 微模型, 但默认不 ship.

---

## 六、browseros-agent (10.8k★ overall) — Agentic 浏览器 fork

### 项目类型

BrowserOS 是 chromium fork (241MB). 我们 sparse 拉了 `packages/browseros-agent` 部分. 整个 project 是 alternative to ChatGPT Atlas / Perplexity Comet / Dia. README L26: "open-source Chromium fork that runs AI agents natively". V 不会 fork 浏览器, 但 agent 部分设计可大量借鉴.

### Agent loop

`apps/server/src/agent/ai-sdk-agent.ts:56-120`: 用 Vercel `ai` SDK 的 `ToolLoopAgent` 包装. 不自写 ReAct.

- `AiSdkAgent.create()` (line 71)
- `createLanguageModel()` (line 76) abstract 7+ provider (Anthropic/OpenAI/Google/Azure/OpenRouter/LMStudio/Bedrock)
- `buildBrowserToolSet()` + MCP clients (line 35-42)
- `normalizeMessagesForModel()` 翻译 message schema (line 39)
- `SessionStore` 映射 conversationId → AgentSession (内存, 无持久化)

System prompt v6 (`agent/prompt.ts:27-59`), 角色按 mode 分: regular / scheduled / chat-mode read-only.

### Tool design (核心 insight)

53 tools / 7 categories:
- Input (17): `click`, `fill`, `type_at`, `drag`, `upload_file`, `select_option`, ...
- Navigation (8): `new_page`, `navigate_page`, `new_hidden_page`, `close_page`, `move_page`, `show_page`
- Observation (9): `take_snapshot`, `take_enhanced_snapshot`, `get_page_content`, `evaluate_script`, `take_screenshot`, `get_dom`, `search_dom`, `get_console_logs`
- Bookmarks (6) / History (4) / Tab Groups (5) / Windows (5)

Schema framework (`tools/framework.ts:9-15`):
```ts
interface ToolDefinition {
  name: string;
  description: string;
  approvalCategory: ToolApprovalCategoryId;  // capability gating
  input: z.ZodType;
  output?: z.ZodType;
  handler: ToolHandler;
}
```

**统一 registry** (`tools/registry.ts:156`): 一处定义, 同时暴露给:
- AI SDK ToolSet (agent loop)
- MCP clients (claude-code/gemini-cli 外部控制)
- UI approval gates (capability category)

### DOM 感知

两口味:
1. **`take_snapshot`** (`snapshot.ts:11`) — flat interactive element tree, 通过 Accessibility API. 元素 ID = backendDOMNodeId (CDP 原生).
2. **`take_enhanced_snapshot`** (line 28) — 完整 a11y tree 含 headings/landmarks/dialogs, snapshot 不够时用.

`get_page_content()` (line 45-80) 出 markdown (headers/links/lists/tables), 大结果写 temp file.

**element ID = CDP backendDOMNodeId**, 不是 nanobrowser 的 ephemeral index. 更稳, 但需 CDP attached.

### Memory 三层

1. **SOUL.md** (`lib/soul.ts`) — 持久化人格. 5000 行上限. 用户可编辑. 模板: "You're not a chatbot. You're becoming someone."
2. **Memory files** — 按日 markdown append, 90 天保留. `memory_search` tool 索 (`tools/memory/`).
3. **Session state** — 内存 only, server 重启丢. client 存 UI 历史, server 重连重建.

### Skills system

`skills/types.ts`: Markdown + YAML frontmatter:
```yaml
---
name: ...
description: ...
license: ...
allowed-tools: ...
---
narrative instructions text
```

不是 tool definition, 是 prompt-injected 叙事指引 ("when extracting emails, also check the reply-to header"). 远端同步走 agentskills.io.

跟 babata skill-evolve 系统设计同构, 都是 "skill = markdown + 事实层不规则层".

### Fork 才能, 扩展不能

| 能力 | Why fork only |
|------|---------------|
| Hidden pages (background 计算) | 扩展只在 active tab 跑 |
| 完整 window 控制 | ext API 限 tab/popup |
| Manifest V2 | Chrome 已 deprecate, fork 保留可装 uBlock v1 等 MV2 ext |
| 长跑 task (1h+) | SW 5 min unload |
| 原生进程调用 | 扩展 sandbox |
| 原生 FS | 扩展只 chrome.storage + sync 限制 |
| 多窗口 workflow | 扩展只管当前窗 tabs |

**校准**: babata 能做 chat + 用户在线时反应式自动化, 不能做后台无人值守长任务. 这是特性不是 bug — 保 lightweight + privacy.

### 必抄

1. **统一 Zod tool registry** (`tools/framework.ts` + `tools/registry.ts`) — 一处定义, AI SDK + MCP + UI approval 三处复用. babata 现在的 sidebar_mcp.py 跟 sidebar_bot.py tools 是分开的, 该统一.
2. **CDP backendDOMNodeId 当 element ID** (`snapshot.ts:11`) — 比 ephemeral index 稳, 跨步骤可引用
3. **Skills = YAML+markdown prompt-inject** — 跟 babata skill-evolve 同构, 直接打通
4. **Tool category + approval gate** — 53 tools 按 category 分级, 用户可粗粒度授权
5. **System prompt 按 mode 分** (prompt.ts:27-59) — regular / scheduled / chat-mode-readonly, babata 的 chat / page-agent / 浏览器管家 三角对齐

### 必拒

无明显 anti-pattern (browseros 是这 6 个里设计最 senior 的). 唯一 calibration: 他们 server 是独立 daemon (apps/server), babata 已经有 sidebar_bot.py 起类似职能, 不要重 invent.

---

## 七、横向对比 matrix

| 维度 | page-assist | chathub | nanobrowser | browserbee | web-llm | browseros |
|------|-------------|---------|-------------|------------|---------|-----------|
| MV3 sidepanel API | ✅ chrome.sidePanel | ❌ popup/sidebar overlay | ✅ side_panel.html | ✅ chrome.sidePanel | N/A web app | N/A fork |
| Multi-model | LangChain switch | Façade per bot | LangChain | BYOK factory | WebLLM only | provider factory |
| Streaming | LangChain `.stream()` | SSE async iter | LangChain | SSE/text | async generator | ai SDK ToolLoop |
| Storage | Dexie v1→v5 | localStorage + Jotai | chrome.storage | IndexedDB+sync | Zustand+localStorage | filesystem |
| Element resolve | N/A (chat-only) | N/A | **selectorMap index** | playwright-crx selector | N/A | **CDP backendDOMNodeId** |
| Multi-agent | ❌ | ❌ | ✅ Navigator+Planner | ❌ | ❌ | ToolLoop only |
| Memory replay | embedding RAG | conversation only | step history (opt) | **tool-seq playbook** | conversation | SOUL.md+90d |
| Tool schema | LangChain | bot.sendMessage | Zod + LangChain | XML 3-tag | N/A | **Zod + 统一 registry** |
| MCP support | ✅ mcpServers | ❌ | ❌ | ❌ | N/A | ✅ 双向 |
| 反 SW kill | ❌ Dexie 重建 | N/A | ❌ task lost | ❌ | SW 模型 keep-alive | server 独立 daemon |
| Vision | ❌ | image upload | ✅ screenshot+bbox | ❌ | ❌ | screenshot tool |

---

## 八、ROI for babata-sidebar

### STEAL list (12 项, 优先级排序)

#### 高优先级 (V0/V1 必做)

1. **Port-based lifecycle sentinel** [page-assist]
   - 抄 `browser.runtime.onConnect("babata-sidepanel")` 模式, 替我们当前的 setTimeout race
   - 落点: `src/service-worker.ts` + `src/sidepanel.tsx` mount 时 connect

2. **统一 Zod tool registry** [browseros]
   - babata 现在 sidebar_mcp.py + sidebar_bot.py tools 散两处, 该一处定义同时暴露给 CC channel + MCP + 扩展 UI
   - 落点: babata main repo `sidebar_tools.py` 统一, 当前两个文件改成消费方

3. **AbstractBot event-stream protocol** [chathub]
   - 当前 babata sidepanel ↔ server 是 ad-hoc 消息, 改成 `AsyncIterable<Event>` + DONE/ERROR 事件流, 失败处理统一
   - 落点: `src/sidepanel/hooks/useChat.ts` (新建) + `sidebar_bot.py` SSE response shape

4. **Per-window conversation state** [browserbee]
   - 当前 babata channel #3 是单全局 session, 跟 V 多窗口工作流冲突
   - 落点: `cc.py` channel #3 加 `windowId` 维度的 session map

5. **selectorMap index + isNew flag** [nanobrowser]
   - babata page agent 当前用 a11y tree ref_id (Anthropic pattern), 但没 `isNew` diff. 加上让 agent 知道 click 后页变了
   - 落点: `src/content/accessibility-tree.ts` 加 stepId + diffWithPrevious

#### 中优先级 (V1)

6. **Defuddle + DOM fallback parser** [page-assist]
   - babata 当前 page 内容抽取是简单 textContent, 升级 robust
   - 落点: `src/content/page-extractor.ts` 新建

7. **lookup_memories(domain) first tool call** [browserbee]
   - babata 已有 site-profile evolver, 但 agent 不主动 lookup. 加 first-call hook
   - 落点: `sidebar_mcp.py` 加 `site_profile_lookup` tool, prompt 加 "always call first"

8. **Skills = YAML+markdown prompt-inject** [browseros]
   - babata skill-evolve 已同构, 缺把"站点 SOP"作 inject. 跟 site-profile 合并方案要 V 拍
   - 落点: `~/cc-workspace/skills-catalog/site-profiles/` 跟 `~/code/babata-sidebar` 这边的 site-profile 合一

9. **Dexie versioned schema** [page-assist]
   - babata 当前 sidebar runtime 走 server JSONL, 不需 Dexie. 但若 V1 加客户端缓存 (offline draft / 历史 search), 该用 Dexie 不要 localStorage
   - 落点: 待 V1 决定客户端缓存策略

10. **chunk.additional_kwargs.reasoning_content 处理** [page-assist]
    - babata 接 Claude/o1 thinking 时直传, 不要折叠
    - 落点: `sidebar_bot.py` SSE 事件转发时保留 reasoning frame

#### 低优先级 (V2 / 可选)

11. **Proxy Tab for CORS** [chathub]
    - 当前 babata 没需要登录态调外部 LLM, 不急. 但若 V1 加 "用 V 自己的 ChatGPT/Claude 网页 session" 模式, 这是唯一解
    - 落点: V2 时考虑

12. **WebLLM 双引擎 pattern (不集成 WebLLM 本身)** [web-llm-chat]
    - 任何重计算 in-ext 场景用 SW (持久) + Worker (离主线) 二选一抽象
    - 落点: 大段翻译 / OCR / 本地 embed 时启用

### REJECT list (6 项)

1. **LangChain 抽象层** [nanobrowser, page-assist] — V 哲学不压 LLM, MCP/直 SDK > 包装层
2. **Hardcoded setTimeout** [page-assist] — port sentinel + ready event > 猜延时
3. **Client-side premium gating** [chathub] — 不 applicable (babata 不收费), 但永远不信 localStorage 是通用铁律
4. **Deprecated /v1/complete** [chathub] — 用 /v1/messages, 不留 sunset 风险
5. **MAX_CONTEXT_TOKENS=12k 硬编码** [browserbee] — model-aware 必要, Claude 200k Sonnet 不该被砍 94%
6. **localStorage Zustand persist 大数据** [web-llm-chat] — 100+ 对话直接溢, 用 IndexedDB + cleanup

### CALIBRATION (跟 babata 已有对照)

| babata V0 已有 | 哪个 ref 验证了路径 | 接下来怎么演化 |
|----------------|---------------------|----------------|
| Anthropic a11y tree pattern (research/01) | nanobrowser selectorMap (Index-based) + browseros backendDOMNodeId | nanobrowser isNew diff 直接补 |
| offscreen WSS keepalive | page-assist Dexie 重建 + browseros server 独立 daemon | offscreen 路径 OK 短期, 长期 V 决定要不要把后端独立 daemon 化 |
| chrome.debugger CDP | browserbee playwright-crx (再封一层) + browseros backendDOMNodeId (CDP 原生) | 不抄 playwright-crx, 直接用 CDP, 跟 browseros 同思路 |
| Preact + Tailwind | chathub Jotai / browserbee React+Zustand / page-assist React+AntD | 加 Jotai atomWithStorage 持久化 multi-view 状态 |
| sidebar_bot.py SSE | chathub AbstractBot 事件流 | 接口统一成 `AsyncIterable<Event>` shape |
| 全 LLM 走 server (cc.py) | browseros provider-factory (7 vendor) / browserbee BYOK factory | server 端已有 cc-router, 客户端不需要再搞 multi-vendor |

### 三个不要犯的错 (calibration)

1. **不要 fork chromium**: browseros 是顶级设计但代价是 fork. babata 是扩展, 接受 hidden page / MV2 / 长跑 task 的局限.
2. **不要本地 LLM 默认开**: web-llm-chat 验证了 1-8B 模型在 2026 不值. cloud-first 是对的.
3. **不要 LangChain**: 5 个对标库里 4 个用 LangChain (page-assist / nanobrowser / browserbee 部分 / web-llm 间接). browseros 用 ai SDK ToolLoop 但不是 LangChain. babata 直接 Anthropic SDK + MCP, 跳过中间层.

---

## 九、对 babata-sidebar V0/V1/V2 的具体修改

### V0 已 ship, 按 `feedback_test_before_ship_to_v` 不动现已运行的, 但下次 session 起手前可加:

### V1 候选 (按 V 拍板优先级)

```diff
src/service-worker.ts
+ port lifecycle sentinel (替 setTimeout race) — 抄 page-assist:207-213
+ "babata-sidepanel" port name 约定

src/sidepanel.tsx
+ Jotai atomWithStorage (multi-view state 持久化) — 抄 chathub:20-24
+ AsyncIterable<Event> useChat hook (替 ad-hoc SSE 消费) — 抄 chathub abstract-bot:38-77

src/content/accessibility-tree.ts
+ isNew flag (跟上 step diff) — 抄 nanobrowser views.ts:91
+ 输出 stepId

src/content/page-extractor.ts (新建)
+ Defuddle + DOM fallback (强化页面抽取) — 抄 page-assist parser/default.ts
```

### babata main repo (server 端)

```diff
sidebar_tools.py (新建, 替原两文件)
+ Zod-shaped Python tool registry (一处定义) — 抄 browseros tools/framework.ts:9-15
+ 同时给 cc.py channel #3 + MCP server + 扩展 approval UI 用

cc.py channel #3
+ windowId 维度 session map (per-window 状态) — 抄 browserbee agentController.ts:49

sidebar_bot.py SSE response
+ AsyncIterable<Event> shape (UPDATE_ANSWER / DONE / ERROR / THINKING) — 抄 chathub
+ chunk.additional_kwargs.reasoning_content 透传 — 抄 page-assist useMessage.tsx:409
```

### V2 候选 (V0/V1 跑稳后再考虑)

- Proxy Tab for CORS (若需要走 V 浏览器登录态)
- WebLLM 双引擎 pattern (若需要离线/重计算 in-ext)
- BrowserOS 风格 SOUL.md + 90-day memory (但 babata 已有 chat-archive + memory v2, 大概率 redundant)

---

## 总结

**集百家之所长** = 抄 12 项, 拒 6 项. 其中 5 项 V0/V1 必做 (port sentinel / Zod registry / event protocol / per-window / isNew diff), 5 项 V1 可做, 2 项 V2 看需要.

**babata 哲学校验**:
- ✅ 事实层 > 规则层: 12 项 STEAL 全部 file:line 锚定, 不发明抽象规则
- ✅ 不压 LLM 上限: REJECT 列表 5/6 都是抽象层 (LangChain / 12k cap / hardcoded delay), 跟哲学骨架 3 一致
- ✅ 渐进披露: 顶部 fast path 表 + 各项目深度 + ROI list 三层
- ✅ 不预留个人化: 所有 STEAL 都是通用模式不带 V 个人偏好
- ✅ 接 baseline: 跟 4 SOTA 标杆同向 (cc/codex/opencode/omo) — Zod tool registry / event stream / per-window state 都是 cc/codex 类似的模式

**下次 V 起手时建议先做 V1 五项必做**: port sentinel → Zod tool registry → AsyncIterable event protocol → per-window session → isNew DOM diff. 这五项把 babata-sidebar 从 V0 的"能用"提升到 V1 的"专业级", 而且每项都 1-2 file 改动, 不大.
