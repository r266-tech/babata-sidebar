# 关键设计决策

每条 D 给: alternatives / chosen / 理由 / source.

---

## 哲学层 (V 决)

### D1 — 全渗透, 不留隐私黑名单
- 备选: 银行 / 邮箱 / 工作 / 私聊默认排除清单
- 选: **不留任何域级排除, V 显式标记单站点 `learning_disabled: true` 才不学习**
- 理由: V 2026-05-07 明示 "不, 要全渗透", 跟 omnipresence vision 配套
- source: babata memory `feedback_no_privacy_blacklist.md` + `user_babata_omnipresence.md`

### D2 — chrome.debugger V0 标配, 黄条接受
- 备选: V0 不上 / V1 才上 / 永不上
- 选: **V0 就上**, 黄条 ("babata 正在调试此浏览器") 接受
- 理由: V 2026-05-07 选 "UX 让步换最强能力". debugger = trusted input (`Input.dispatchMouseEvent` `isTrusted=true`), 反检测 / captcha / banking automation 必备. 黄条=disclosure, 跟 visual indicator 互补
- source: V 直接答复 + research/03 finding 4 + research/01 finding 7

### D3 — Cross-channel context = 读 chat-archive (RO) + 写自己 state
- 备选: 完全独立 channel / 完全 cross-channel session merge
- 选: **中间档** — sidebar mount `~/cc-workspace/chat-archive/` 只读看 TG/微信历史, 自己 state 写 `~/.babata/sidebar/state.json`
- 理由: 渗透哲学要求一致性, 但 babata channel-sticky session 模式不破. chat-archive 已是 cross-channel long-term memory
- source: V 接受我建议

---

## 架构层 (我决)

### D4 — 浏览器扩展 = 单独 repo `r266-tech/babata-sidebar`
- 备选: 进 babata main repo / 多 sub-repo
- 选: **单独 repo (TS/Vite 工具链)**, server 端进 main repo
- 理由: 工具链不同 (Python uv vs TS npm) / 用户可独立装扩展不装 server / 跟 openclaw-sidebar 拆法一致

### D5 — server 端进 babata main repo, 跟 TG/微信 channel 平级
- 备选: 单独 sidebar-server repo
- 选: **main repo**, 增 `sidebar_bot.py` / `sidebar_mcp.py` / `sidebar_bridge.py`, `cc.py` 加 channel #3
- 理由: One CPU 铁律. 三件套跟 `bot.py` / `weixin_bot.py` 完全同构, 复用最大化

### D6 — 单机 only, no Tailscale fallback (V0)
- 备选: 复刻 openclaw 的本地+远程双 URL fallback
- 选: **只 127.0.0.1:18791**, V2 再加 Tailscale
- 理由: V 2026-05-07 "暂时先不考虑 tailscale". 单机简化

### D7 — HTTP loopback over nativeMessaging
- 备选: nativeMessaging (零端口) / 双通道
- 选: **单 HTTP loopback :18791**
- 理由: 跟 TG bot / 微信 bot 统一架构 (都 launchd Python 服务). 单机暴露 loopback 是 V 自装自用接受的. nativeMessaging 还要写 Rust/Python host + JSON manifest 各 OS 装, 复杂度更高

### D8 — A11y tree 自拼 (browser-use 扁平格式), 不调 CDP `Accessibility.getFullAXTree`
- 备选: CDP 取标准 AXTree / 直接给 LLM 截图 (computer-use)
- 选: **page-side `__generateAccessibilityTree`** (跟 Anthropic Claude in Chrome 1.0.70 一致), 输出 `[refN]<role>"name" attrs`
- 理由: 跨 frame 不需 attach 每子 target / 单行扁平 token 比 CDP JSON 省 50%+ / WeakRef 元素 map 优雅 / WebClaw 实测 GitHub 78% 缩减
- source: research/01 finding 1 + research/04 finding 5

### D9 — Visual indicator 用 Shadow DOM (改进 Anthropic 版)
- 备选: 顶 frame inline DOM (Anthropic 做法, 用 `id="claude-*"` 防冲突, 但实测被页面 CSS `*[id^=claude-]` 污染)
- 选: **Shadow DOM `mode:"closed"` + `:host{all:initial}`**
- 理由: 物理隔离更稳, 不被站点 CSS 污染
- source: research/01 finding 6

---

## Site profile (我决)

### D10 — site profile 两层物理分 (私 + 公)
- 选: **`~/.babata/sidebar/sites/<domain>.md`** (私, never git) **+ `r266-tech/babata-site-profiles/sites/<domain>.md`** (公 OSS, V1+)
- 私层 frontmatter `upstream: <repo>@<commit>` lockfile-style pin
- source: research/06 finding 8 + finding 10

### D11 — site profile evolution = 异步 launchd consumer
- 备选: 同步 (卡 UI) / 后台 SW (生命周期不可靠)
- 选: **launchd `com.babata.sidebar-profile-consumer` 每 5min**, 跟 `~/.claude/skills/skill-evolve/consumer.sh` 同构
- 理由: 跟 babata skill-evolution 完全同构, 代码可复用. 异步永不卡 UI

### D12 — site profile 数据格式 = markdown + frontmatter + lockfile
- 选: **跟 skill-evolve SKILL.md 同结构** — frontmatter (domain / aliases / upstream / spa / last_updated / visit_count / confidence) + markdown sections (Page types / Anchors / Noise blacklist / Quirks / Translation strategy / Action recipes / Learning meta)
- 理由: LLM 可读可改, 不引专有 schema; 跟 babata 整体 markdown-first 一致
- source: research/06 finding 6

---

## Translation (我决)

### D13 — inline 双语 = DOM 直接注入 `<font class="bbt-tr">` + IntersectionObserver
- 备选: Shadow DOM 包译文 / `<ruby>` / CSS pseudo
- 选: **DOM 直接注入** (沉浸式翻译实测路线), Shadow DOM 仅给浮层
- 理由: 大规模翻译 Shadow DOM 撞 [Firefox bug 1841656](https://bugzilla.mozilla.org/show_bug.cgi?id=1841656); `<font>` 标签语义已弃用不撞站点 CSS; ⌘A 复制能拿到译文; 用户可关 (toggle `.bbt-off` class)
- source: research/02 finding 1 + research/05 finding 1

### D14 — 翻译 backend 全走 babata server SSE (one CPU 铁律)
- 备选: 直调 OpenRouter / Anthropic / OpenAI (快 / 便宜)
- 选: **POST babata server `/sidebar/translate` SSE**
- 理由: One CPU 铁律不破. 沉浸式 30+ provider 是 product mode, babata 单 V 用不需要

### D15 — 选区翻译 = Shadow DOM 浮层
- 选: **`attachShadow({mode:"closed"})` + `:host{all:initial}`**
- 理由: 防站点 z-index 冲突 / 防 CSS 污染
- source: research/05 finding 2

### D16 — 翻译复用沉浸式 137 站点配置 + 段落识别规则
- 选: **抄沉浸式 `default_config.content.json/generalRule`**: `inlineTags` / `stayOriginalTags` / `lineBreakRegexStr` / `additionalStayOriginalSelectors`
- 理由: 沉浸式 v1.28.5 这套是 5 年踩坑积累, 直接复用跳过 90% 工程成本
- source: research/02 finding 2

---

## UX (我决, 体现 "如呼吸如原生")

### D17 — 默认 always-on
- 选: **V 装好后 sidebar SW 跟随 Edge 启动激活, content script 进每个新 tab document_start 注入, 不等 V 触发**
- 理由: V 2026-05-07 "如呼吸" — 不需要召唤, 自动 + 持续 + 无感

### D18 — 静默自愈, 无 toast 无 badge
- 选: **profile miss / 学习中 / API 错 / SW 重启 全程不弹通知**, 仅 sidebar 内 ambient 状态
- 理由: babata 哲学骨架 4 + `feedback_self_heal_no_escalate.md`. V 用 babata 替代沉浸式, 不能比沉浸式更吵

### D19 — 沉浸式肌肉记忆快捷键继承
- 选: **Alt+A (翻当前页) / Alt+W (翻整页) / Alt+S (开 sidebar) / Alt+I (翻输入框)** 直接抄
- 理由: V 已用沉浸式多年肌肉记忆, 不破 (`feedback_ui_preferences.md` UX 服务人不服务 AI)
- source: research/02 finding 9

---

## 实施 (我决)

### D20 — 一次申请全权限
- 选: **install 时全部 permission 一次申请**, 不 `optional_permissions` 渐进
- 理由: V 自装自用没 first-run 心理震慑. 渐进徒增烦扰

### D21 — 品牌色沿用 babata main repo 既有视觉
- 选: **从 babata main repo / openclaw-sidebar 既有视觉延续**
- 理由: babata 是 V 的 brand, 不另造一套. 视觉资产自查 babata main repo 后落

### D22 — V0 私有 repo, V0 跑通后讨论 OSS
- 选: **现 `r266-tech/babata-sidebar` private**, V 验收 V0 后讨论 OSS
- 理由: V0 含决策文档 + 设计意图, fit V 验收后再公开. 公共 site profile 用单独 repo `babata-site-profiles` 直接 OSS (V1+)
