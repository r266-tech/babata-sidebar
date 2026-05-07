# A11y Tree 怎么给 LLM 用最有效

## 总览

A11y tree 比 `querySelectorAll('input,button,a,...')` 强一档的核心原因有三:

1. **语义优先于标签**: a11y 节点带 `role`/`name`/`value` 三件套, 是浏览器渲染引擎根据 ARIA + heuristic 计算后的"用户视角语义", 一个无障碍 div 加 `role="button"` + 一个原生 `<button>` 在 a11y 树里看着完全一样, querySelector 看不到这一层。
2. **跨 iframe 一棵树**: CDP 的 `Accessibility.getFullAXTree` 接收 `frameId`, 配合 `Target.setAutoAttach` 可以聚合 OOPIF 跨进程子 frame, querySelector 跨 origin 直接 0 结果。
3. **官方权威**: Anthropic 自家 Claude for Chrome 扩展 (v1.0.56) 用的就是这条路 (`window.__generateAccessibilityTree`); Microsoft Playwright MCP / Browserbase Stagehand / browser-use 主流派全在 a11y tree 上做剪枝。

但 raw a11y tree 直接喂 LLM = token 灾难 (Playwright MCP GitHub 一页 19K token, Wikipedia 16K)。**主流做法 = a11y 语义 + 自定义 ref 编号 + 激进剪枝 (只 interactive / 只 viewport / 只可见层)**, 把 16K token 压到 4K 以内 (WebClaw 实测 51%-79% 缩减)。screenshot+SoM (Set-of-Mark) 是另一条主线 (WebVoyager 59.1% > 文本 40.1%), 但纯视觉 + a11y tree 互补不互斥 — 我们 babata-sidebar 默认 a11y tree, 重客户端复杂 UI fallback screenshot。

---

## Finding 1: CDP `Accessibility.getFullAXTree` 是物理实现层

**Source**: [Chrome DevTools Protocol - Accessibility Domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)

`getFullAXTree(depth?, frameId?)` 返回 `nodes: AXNode[]`。AXNode 12 个核心字段:

```
nodeId, ignored, ignoredReasons, role(AXValue), chromeRole(AXValue),
name(AXValue), description(AXValue), value(AXValue),
properties(AXProperty[]), parentId, childIds, backendDOMNodeId, frameId
```

`AXValue.type` 枚举有 16 种 (boolean / tristate / idref / nodeList / role / internalRole / token / ...), `properties` 里 ARIA 状态 (checked / expanded / pressed / required / focusable) 全在。`backendDOMNodeId` 是 a11y 节点 → DOM 元素的桥梁, 后续 click / type 用它定位真实 DOM 元素。

跟 DevTools "Accessibility" 面板**同源**: 都来自 Chromium `BlinkAXTreeSource`, 只是面板渲染成 UI 树, CDP 暴露 JSON。

**babata 实现**: chrome.debugger attach + `Accessibility.enable` + `getFullAXTree` 拿 raw 树; 转 LLM 友好格式之前**先存 backendDOMNodeId → AXNode 的 map**, 让 LLM 给的 ref 能反查回 DOM 做 click。

---

## Finding 2: AOM 标准 Phase 4 还没就绪, CDP 仍是唯一可行路径

**Source**: [WICG/aom explainer](https://github.com/WICG/aom)

AOM 4 phase: ① reflect ARIA attrs ② element refs ③ Custom Element default semantics ④ **Full Introspection of Accessibility Tree**。

Phase 4 现状 (2025): WebDriver 层有 `computedrole` / `computedlabel` (跨 WebKit / Chromium / Firefox), 但 JS 同步访问完整 a11y tree 的 API 没标准化。Chromium 有 experimental flag, WebKit 实验实现已计划下线。

**结论**: 浏览器扩展场景下 AOM 不可用, 必须走 CDP。babata-sidebar 在 manifest 里加 `"debugger"` 权限, 用 `chrome.debugger.attach` 拿 CDP session。

---

## Finding 3: Anthropic 官方 Claude for Chrome 用的就是 a11y tree (而非纯 querySelector)

**Source**: [Claude for Chrome Extension Internals (v1.0.56) gist](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)

注入函数: `window.__generateAccessibilityTree(filter, depth=15, maxChars=50000, refId?)`

DOM → ARIA 映射 (无 ARIA 时 fallback): `<a>`→link, `<button>`→button, `<input type="text">`→textbox, `<select>`→combobox。Accessible name 取自 `aria-label > placeholder > title > alt > <label> > textContent` 优先级链。

输出格式 (缩进文本, 不是 JSON):

```
button "Search" [ref_3] type="submit"
  textbox "Query" [ref_4] placeholder="Enter keywords"
combobox "Country" [ref_5]
  option "USA" (selected) value="us"
```

`window.__claudeElementMap` 用 `WeakRef` 存 `ref_X → element`; filter 模式 `"interactive"` 默认 (button/link/input only) vs `"all"`; 超 50K char 报错让 LLM 收窄 depth 或 refId。配套 `find` tool 触发**嵌套** Claude (Sonnet 4.5, 800 tokens) 做语义匹配 — 不是单纯文本检索。

**babata 实现**: 直接 ride 这套设计 — 同样的注入函数 + WeakRef 元素 map + 缩进文本输出。babata 跟 Claude for Chrome 都是 Anthropic 内核, 跟 V 的 "one CPU" 哲学吻合。

---

## Finding 4: Anthropic 官方 computer-use API **不接受** a11y tree, 只吃截图+坐标

**Source**: [Claude computer-use docs](https://platform.claude.com/docs/en/docs/build-with-claude/computer-use)

三个内置 tool: `computer_20251124` (display_width_px / display_height_px / display_number / 可选 enable_zoom) + `text_editor_20250728` + `bash_20250124`。computer tool **schema-less** — 内置在模型里不能改, 只能传 screenshot, 模型回 `{action, coordinate}`。

Token 成本: system prompt overhead 466-499 token + computer tool 定义 735 token + 每张截图 (Opus 4.7 长边 2576px / 1\:1 坐标, 旧模型 1568px / 1.15 MP) ~1500-3000 token。

**关键**: extension sidebar 场景 (用户主动开侧栏看 LLM 干活) ≠ headless container computer-use 场景。我们应该走 **CDP a11y tree (Claude for Chrome 路线)**, 不是 computer-use API。computer-use 是给"完全没有 DOM 入口"的桌面 / VM 准备的 fallback, 浏览器里用是降智。

**babata 决策**: 默认 chat tool-use API (不带 computer beta header), 工具走自定义 `read_page` (输出 a11y tree 文本) + `click(ref)` + `type(ref, text)` + `screenshot()` (复杂 canvas / 自定义 drag 时兜底)。

---

## Finding 5: browser-use 用 `[backend_node_id]<tag attrs>` 单行扁平格式 + AX tree 增强

**Source**: [browser_use/dom/serializer/serializer.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/serializer.py), [clickable_elements.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/clickable_elements.py)

格式 (示例):

```
[42]<button type=submit>Search</button>
*[43]<input placeholder="Email" type=email />
|scroll element[44]<div role=listbox>
[45]<option value=us>USA</option>
```

`*` 前缀 = 上次以来新出现的元素; `|scroll element` = 可滚动容器; 默认 `DEFAULT_INCLUDE_ATTRIBUTES` ~50 个 (form: type/checked/placeholder/value/required/disabled, a11y: role/aria-label/aria-expanded, ID: id/name/title)。

Interactive 判据 (clickable_elements.py): native 标签 (button/input/select/textarea/a/details/summary/option) ∪ ARIA role (button/link/menuitem/option/radio/checkbox/tab/textbox/combobox/slider/spinbutton/searchbox/cell/gridcell) ∪ event handler (onclick / onmousedown / onkeydown / tabindex) ∪ AX property (focusable / editable / settable / keyshortcuts) ∪ CDP detected listener (Vue/React/Angular)。

**关键**: 显式**不**做 size 0 过滤 ("invisible overlays can be interactive"), 只过 `ax_node.ignored` + `html`/`body` + `data-browser-use-exclude` 属性。

**babata 决策**: 抄 browser-use 的扁平 `[ref]<tag>` 格式 (比 Playwright YAML 缩进省 token) + 抄 interactive 判据全集 + 不做 size 0 过滤。

---

## Finding 6: Playwright `ariaSnapshot()` YAML 格式权威但 verbose

**Source**: [Playwright Aria Snapshots](https://playwright.dev/docs/aria-snapshots), 实测 `mcp__playwright__browser_snapshot` on example.com

实测输出 (example.com, 全页只有标题+一段+一个链接):

```yaml
- generic [ref=e2]:
  - heading "Example Domain" [level=1] [ref=e3]
  - paragraph [ref=e4]: This domain is for use in...
  - paragraph [ref=e5]:
    - link "Learn more" [ref=e6] [cursor=pointer]:
      - /url: https://iana.org/domains/example
```

格式契约: `- role "name" [attr=value] [ref=eN]`, 下挂 `/url` `/text` 子字段, 嵌套用 YAML 缩进。playwright-mcp 用 `ref=e5` 让 LLM 引用元素, snapshot 内 ref 稳定, 页面变化后失效。

**问题**: YAML 缩进每层 2 空格 + 引号 + ref 占位, 比 browser-use 的 `[42]<button>` 单行胖 — Wikipedia 16K token vs WebClaw 7.8K, 51% 浪费。

**babata 决策**: 不用 YAML, 用 Playwright 的 ref 命名约定 (`e1` / `e2` 数字递增) 但格式抄 browser-use 单行扁平。

---

## Finding 7: Token 实测对比 (关键决策依据)

**Source**: [How Accessibility Tree Formatting Affects Token Cost in Browser MCPs](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a)

WebClaw vs Playwright MCP 三站对比:

| 站点 | Playwright MCP | WebClaw | 缩减 |
|---|---|---|---|
| Wikipedia | 16,044 tokens / 64,176 char | 7,860 / 31,439 | **51%** |
| GitHub | 19,409 / 77,637 | 4,304 / 17,215 | **78%** |
| Hacker News | 14,547 / 58,189 | 3,052 / 12,207 | **79%** |

GitHub 78% 缩减来自 Playwright MCP 给所有元素 (789 ref) 编号, WebClaw 只给 interactive (245 ref)。Playwright MCP 实测有"Burns 114K Tokens Per Test" 的 case。

**babata 目标**: 单页 a11y dump < 5K token (大型站点); 实现策略 = 只 interactive + 视口剪枝 + 单行扁平 + 折叠重复 + paint_order 去 occluded。

---

## Finding 8: 跨 iframe / 跨 origin 必须 attach 每个子 target (Stagehand 范本)

**Source**: [Taming iframes: A Stagehand Update](https://www.browserbase.com/blog/taming-iframes-a-stagehand-update), [chrome.debugger API docs](https://developer.chrome.com/docs/extensions/reference/api/debugger)

`Target.setAutoAttach` 只 attach 直接子 frame, 三层嵌套 A→B→C 必须**对 B 也调一次** setAutoAttach 才能拿到 C。Chrome 125+ 有 "flat session" 模式: 主 debugger session 下挂多 child target, 用 `sessionId` 路由 sendCommand, 不需要再 `chrome.debugger.attach` 一次。

Stagehand 实战: 深度优先遍历所有 frame, 每个节点的 ID 改成 `(frame_ordinal, backend_node_id)` 复合 ID 保唯一; 用 WeakMap 存 frame → CDP session, click 时按 frame 路由对应 session。

**babata 实现**: manifest 加 `debugger` permission; 启动 attach 后立刻 `Target.setAutoAttach({autoAttach: true, flatten: true, waitForDebuggerOnStart: false})`, 监听 `Target.attachedToTarget` 递归对每个 child frame 也 setAutoAttach; 复合 ref ID 用 `e{frameOrdinal}_{backendNodeId}` 编号。

---

## Finding 9: 剪枝 = paint_order + viewport + interactive-only 三件套

**Source**: [browser_use/dom/serializer/paint_order.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/paint_order.py)

paint_order 算法: 拿到所有 node 的 `paintOrder` (CDP `DOMSnapshot.captureSnapshot` 提供), 按 paint 倒序 (高 z-index 先) 累计 RectUnion, 每个低层 node 检查 bbox 是否被 union **完全包含** → 标 `ignored_by_paint_order=True`。容错: 透明 / 低 opacity 元素不进 union; rect 数 cap 5000 防爆。

剪枝三层:
1. **Interactive only** (Finding 5 判据)
2. **Paint order** (干掉被覆盖的)
3. **Viewport-aware** (off-screen 的可选不发, agent 想要就 scroll + 重发)

**babata 实现**: 同时跑 `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot` (后者拿 paint order + bbox), 两棵树按 `backendNodeId` join, 剪枝完输出。

---

## Finding 10: 视觉路线 (WebVoyager / SeeAct-V) 在视觉密集任务上碾压纯文本

**Source**: [WebVoyager arxiv](https://arxiv.org/html/2401.13919v4), [UGround / SeeAct-V arxiv](https://arxiv.org/html/2410.05243v3), [SeeAct project](https://osu-nlp-group.github.io/SeeAct/)

WebVoyager 核心数字:
- 文本-only (a11y tree) **40.1%** 任务成功
- 多模态 (screenshot + 数字 SoM 标记) **59.1%**
- 19 点 gap 主要来自"视觉密集" 站点 (Booking / Flights / 日历)

UGround (SeeAct-V): 纯视觉 grounding 模型, 10M GUI element + 1.3M screenshot 训练。原文核心论点: "HTML 比对应视觉**多 10×** token", a11y tree 提取本身有延迟。ScreenSpot 73.3% (vanilla) / 81.4% (agent w/ GPT-4o)。

**关键 take**: 视觉路线赢在**视觉密集**, 不是赢在所有场景。文本-form-heavy 站点 (gmail / github / docs) a11y tree 仍是更准更省的选择。

**babata 实现**: 双轨制 — `read_page` (默认 a11y tree, 给 90% 站点用) + `screenshot` tool (LLM 显式调, 用于 canvas / svg 视觉布局 / 拖拽); 不像 WebVoyager 每步都截图 (那个 token 烧得离谱)。

---

## 整合 babata-sidebar 实现路线 (短)

1. **manifest** 加 `"debugger"` + `"activeTab"` + `"scripting"`, sidebar 走 `chrome.sidePanel`
2. attach 后 enable `Accessibility` + `DOMSnapshot` + `Target` (autoAttach + flatten)
3. 每次 LLM 调 `read_page`: getFullAXTree → join DOMSnapshot → 剪枝 (interactive + paint_order, 不做 size=0 过滤) → 输出 `[e1]<button>...` 单行扁平 + WeakRef map
4. `click(ref)` / `type(ref, text)` 反查 backendNodeId → CDP `Input.dispatchMouseEvent` 或 `DOM.focus` + `Input.dispatchKeyEvent`
5. `screenshot()` 兜底, LLM 自己判断要不要调
6. 跨 iframe 复合 ref 编号 `e{frame}_{node}`, click 路由对应 frame 的 CDP session
7. 目标 single dump < 5K token (大型站点), 视口外节点等 LLM 主动 scroll

Sources:
- [chrome.debugger | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)
- [Claude for Chrome Extension Internals gist (sshh12)](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)
- [Anthropic computer-use docs](https://platform.claude.com/docs/en/docs/build-with-claude/computer-use)
- [browser-use serializer.py / clickable_elements.py / paint_order.py](https://github.com/browser-use/browser-use/tree/main/browser_use/dom/serializer)
- [Playwright Aria Snapshots](https://playwright.dev/docs/aria-snapshots)
- [How Accessibility Tree Formatting Affects Token Cost (DEV.to kuroko1t)](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a)
- [Taming iframes: A Stagehand Update (Browserbase)](https://www.browserbase.com/blog/taming-iframes-a-stagehand-update)
- [WebVoyager arxiv 2401.13919](https://arxiv.org/html/2401.13919v4)
- [UGround / SeeAct-V arxiv 2410.05243](https://arxiv.org/html/2410.05243v3)
- [WICG/aom explainer](https://github.com/WICG/aom)
