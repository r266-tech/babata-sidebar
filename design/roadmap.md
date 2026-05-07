# Roadmap

不带日期 (per babata memory `feedback_no_deadline_hierarchy.md`), 用里程碑描述.

---

## V0 — 替代 openclaw-sidebar + 替代沉浸式翻译网页核心 + page agent + 浏览器管家基础

11 项. 验收 = V 卸载 openclaw-sidebar + 网页翻译场景下不切回沉浸式.

1. **chat sidebar** + 流式 markdown + 选中即引用 + 图片粘贴 (复刻 openclaw 9 功能)
2. **页面上下文自动注入** (URL / title / a11y tree / 选中文本) — a11y tree content script 替代原 querySelector
3. **SPA 支持** — `webNavigation.onHistoryStateUpdated` + `chrome.tabs.onUpdated` (vs openclaw content script monkey-patch pushState)
4. **划词翻译** Shadow DOM 浮层
5. **网页 inline 双语翻译** — DOM 直接注入 `<font class="bbt-tr">` + IntersectionObserver, 复用沉浸式 137 站点 inlineTags / stayOriginalTags / lineBreakRegexStr
6. **agentic page action loop** — chrome.debugger CDP, MCP tool surface (`page_a11y` / `page_click` / `page_type` / `page_screenshot`) 替代 openclaw 的 `[[page_action]]` text marker
7. **Visual indicator** — Shadow DOM phantom cursor (跟 `Input.dispatchMouseEvent` 联动) + glow border + stop button
8. **Bookmarks / tabs / history / downloads 看与整理** — chrome.bookmarks / tabs / tabGroups / history / downloads, 自然语言入口 ("帮我整理 tabs", "收藏这个并归到 LLM 资料")
9. **Site profile lookup + 5 个手写 popular 站点** — x.com / mail.google.com (anchor only, learning_disabled) / youtube.com / github.com / reddit.com (Defuddle import + 改格式)
10. **Cross-channel context** — sidebar mount `~/cc-workspace/chat-archive/` 只读
11. **launchd 自启** + `auto-update.sh` 接入 (`com.babata.sidebar-bot` plist)

---

## V1 — 替代沉浸式翻译完整功能 + site profile 自动学习

5 项.

1. **Youtube 字幕双语** — innertube `/youtubei/v1/player` + DOM 同步 `.ytp-caption-segment` (research/05 finding 3)
2. **PDF 双语** — declarativeNetRequest redirect 到打包 PDF.js fork + 双语 inline (research/05 finding 5)
3. **Site profile 自动学习** — launchd `com.babata.sidebar-profile-consumer` 异步 evolver, 跟 skill-evolve consumer 同构
4. **私密 + 公共两层 site profile + lockfile** — `~/.babata/sidebar/sites/` 私 + `r266-tech/babata-site-profiles` 公, frontmatter `upstream: <repo>@<commit>` pin
5. **V 用户控制面板** — sidebar "本站经验" tab 完整: 看 / 改 / 标错 / 一键清空 / 导出 PR seed (research/06 finding 11)

---

## V2 — 差异化 + 跨设备 + OSS

5 项.

1. **Netflix 字幕** — DOM hook `.player-timedtext-text-container` MutationObserver (DRM 影响传输不影响渲染)
2. **漫画 OCR** — 一步多模态 LLM (Gemini-3.1-flash / Claude Sonnet / mimo-omni) 返回 `{boxes, text}`, Canvas overlay 贴回 (research/05 finding 6)
3. **视频自动 ASR** — `chrome.tabCapture` + offscreen + Whisper/mimo-omni 流式 + `addTextTrack` (research/05 finding 8)
4. **Tailscale 远程跨家/办公室 Mac** — 复刻 openclaw 双 URL fallback
5. **OSS 公开** — `r266-tech/babata-sidebar` 转 public + `r266-tech/babata-site-profiles` 公共 repo (CI puppeteer 验 selector + anonymous hash 防真名)

---

## 验收标准

### V0 关卡 ("V 用 babata sidebar 替代 openclaw + 网页翻译场景")
- V 在 sidebar 用 babata ≥ 5 天后, 主动卸载 openclaw-sidebar (sidebar chat 体验已超越)
- V 至少 3 次用 inline 翻译成功 (网页双语场景下不切回沉浸式)
- agent page action 至少 3 个真实任务成功 (e.g. "帮我整理 tabs", "收藏这个并归到 LLM 资料", "关掉所有非工作 tab")
- a11y tree 单页 dump < 5K token (大型站点 X / GitHub)
- profile lookup < 10ms

### V1 关卡 ("V 卸载沉浸式翻译")
- V 主动卸载沉浸式翻译 (Youtube + PDF + 网页全场景)
- site profile 自动学习准确率 ≥ 70% (V 反馈 "学的对" 比例)
- launchd consumer 5min 节奏稳定运行 ≥ 2 周

### V2 不锁验收
- 看 V 心情 + tanka 工作密度.

---

## 反向 milestone — 砍

跟 V 哲学骨架 (薄优先) 自审, V0 砍掉:
- ❌ Tailscale fallback (V 2026-05-07 暂不要)
- ❌ Pro 订阅 / 翻译多 provider 切换 (沉浸式有, V 不需要)
- ❌ 触摸屏手势 (V 桌面用, 不需要)
- ❌ 7 种翻译 theme (沉浸式有, V0 1 种 default 即可)
- ❌ Tesseract.js wasm 8.8MB (V 走多模态 LLM, 不要本地 OCR)
- ❌ Cookies permission (V0 不申请, V1 评估)

V0 砍后预估 ≤ 2500 行 TS + ≤ 1500 行 Python.
