# babata-sidebar 项目入口 (LLM-targeted)

## 核心事实

- **私有 repo**: `r266-tech/babata-sidebar` (本地 `~/code/babata-sidebar/`)
- **server 端**: 在 babata main repo `~/code/babata/sidebar_*.py` (本 repo 仅扩展)
- **runtime 速查**: babata memory `reference_babata_sidebar_runtime.md`
- **当前阶段**: V0 已 ship + 翻译模块通用化重写 + server LLM HTTP 直调; 状态 + 路线见 `project_babata_sidebar.md` memory

## 项目结构

```
research/    7 份深度调研 (code-grounded)
  01-claude-in-chrome.md            Anthropic Claude in Chrome 1.0.70 反编译
  02-immersive-translate.md         沉浸式翻译 (闭源) 反编译
  03-mv3-architecture.md            Manifest V3 / SW / offscreen / sidepanel 架构
  04-a11y-tree-for-llm.md           a11y tree 序列化 LLM 友好格式
  05-translation-injection.md       DOM 注入双语翻译策略
  06-site-profiles.md               Site profile 异步演化
  07-ai-chat-extensions-deep-dive.md   6 个开源 chat 扩展深度调研 (本 session 加)

design/      4 份设计文档
  architecture.md / decisions.md / roadmap.md / risks.md

src/         扩展源码 (Preact + Vite + Tailwind)
scratch/     译翻 references symlink (~/code/translate-references → 4 开源翻译库)
```

## 长期 workflow 铁律 (V 立约)

任何代码改动前, 先 grep 对标库找别人怎么做的 — **不重新空想**. 两条并列铁律:

### 翻译方向: 5 源对标 (V 2026-05-08 立约)

铁律: 翻译相关改动 / 新需求 / debug 第一步 grep 5 源 (`reference_translate_open_source_4_repos.md` 4 开源 + `reference_immersive_translate_v1_28_5.md` 闭源)

```
~/code/translate-references/
  read-frog/             页面级 context 真 LLM-native 差异化
  fluentread/            渲染策略
  kiss-translator/       DOMParser 占位最强 / shadow DOM 三路 fallback
  old-immersive-translate/  早期沉浸式开源版

(闭源 Edge 沉浸式 v1.28.5 反编译 sediment 在 reference_immersive_translate_v1_28_5.md)
```

设计 v2 矩阵 + ROI + 反模式见 `project_babata_sidebar.md` Milestone 4.

### chat/agent/sidebar 方向: 6 源对标 (V 2026-05-08 立约)

铁律: chat UX / agent loop / tool design / streaming / per-window state / element 解析 / multi-model adapter 任何改动, 第一步 grep `~/code/ai-extension-references/` 6 源 + 看 `research/07-ai-chat-extensions-deep-dive.md`

```
~/code/ai-extension-references/
  page-assist/      7.9k★ Ollama sidebar 标杆 (port sentinel / Dexie schema / Defuddle)
  chathub/         10.6k★ multi-bot 比较 (AbstractBot event-stream / Façade / Proxy Tab CORS)
  nanobrowser/     12.9k★ multi-agent automation (selectorMap index / isNew diff / Zod actions)
  browserbee/        972★ "Cline for web" (per-window state / lookup_memories first call)
  web-llm-chat/    1.0k★ WebGPU 浏览器内 (SW+Worker 双引擎; 但 babata 不集成 WebLLM)
  browseros/      10.8k★ agentic 浏览器 fork (统一 Zod registry / CDP backendDOMNodeId / Skills YAML)
```

V0/V1 必做 5 项排序: Port sentinel → Zod tool registry → AsyncIterable event protocol → per-window session → selectorMap+isNew DOM diff. 完整 12 STEAL / 6 REJECT + 具体 diff 在 `research/07-ai-chat-extensions-deep-dive.md`.

## 不要做

- **不 fork chromium** (browseros 模式) — 接受 hidden page / 长跑 task / MV2 局限, 换 lightweight + privacy
- **不集成 WebLLM** — 2026 cloud-first (Sonnet/Opus) 比 1B-8B 本地强代差; 跟 `feedback_local_first_no_cloud` 不冲突 (那条针对 runtime/memory 不针对模型推理)
- **不引入 LangChain** — V 哲学 "不压 LLM 上限", 直 Anthropic SDK + MCP > 包装层
- **不 site-specific** — 翻译方向已废 paragraphSelectors, chat/agent 方向同样 (V 哲学 "通用不 site-specific")

## babata 哲学锚

- **事实层 > 规则层** — file:line 锚定, 不发明抽象规则
- **集百家之所长** — 5+6=11 库 + Anthropic 1 = 12 库对标 (翻译 5 / chat 6 / Anthropic 1)
- **写完代码自测** — `feedback_test_before_ship_to_v` chrome-devtools mcp / curl 跑闭环, V 不是 QA
- **基建变动十分谨慎** — `feedback_infra_max_caution` 改 SW / sidebar_bot.py / sidebar_translate.py 必 codex 多轮 review

具体 V 偏好 / project state / 历史 milestone 见 babata memory:
- `project_babata_sidebar.md` — 项目状态指针 + 5 个 milestone
- `reference_babata_sidebar_runtime.md` — runtime 速查
- `feedback_translate_native_experience.md` — 翻译产品北极星
- `reference_translate_open_source_4_repos.md` — 翻译 4 库 ROI
- `reference_immersive_translate_v1_28_5.md` — 沉浸式 v1.28.5 反编译
- `reference_ai_chat_extensions_6_repos.md` — chat/agent 6 库 ROI (本 session 新)
