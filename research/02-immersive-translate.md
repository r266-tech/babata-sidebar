# 沉浸式翻译 4 大场景实现调研

> 信息源: 本机 Edge 扩展 v1.28.5 解包 (`/Users/admin/Library/Application Support/Microsoft Edge/Profile 1/Extensions/amkbmndfnliijdhojkpoglbnaaahippg/1.28.5_0/`) + 官方文档站 + 公开技术分析。代码闭源, 但 minified content_main.js (2.86 MB / 11503 行) 仍能 grep 到 class 名/类方法名/选择器, `default_config.content.json` (143 顶层 key) 几乎是规则引擎 schema 的明文。

## 总览 (3 句)

1. 网页翻译走的是 "DOM TreeWalker 扫节点 + 启发式段落识别 + 在原节点旁追加 `<font class=immersive-translate-target-translation-block-wrapper>` 包裹译文" 的纯 DOM 注入路径, 由 `default_config.content.json/generalRule` 驱动 (paragraphMin / atomicBlockSelectors / inlineTags / stayOriginal* 等十几个 rule), 站点级别再用 `rules` 数组叠 override。
2. 视频字幕复用 137 个站点的 `subtitleRule` 配置 + 一个 5KB 的 `video-subtitle/inject.js` (这文件混淆但相对完整), 在页面 main world hook `XMLHttpRequest.open/send` 和 `fetch`, 拦截字幕 URL 后替换 response 注入双语 cue, 每站点独立 class (YouTube / Netflix / Udemy / Disney+ / Hulu / Mubi / TED / EBUTT / WebVTT 等), Netflix 走 `JSON.parse` hook 拿 `timedtexttracks` 而不是抓 DRM segment。
3. PDF 走 "本地不渲染, 上传到服务端" 路径 — `pdf/index.html` 是个 iframe shell, 把 PDF blob `postMessage` 给 `app.immersivetranslate.com/pdf` (BabelDOC 引擎); 漫画也是同模式 — Tesseract.js 5.1.1 (8.8 MB wasm) 只是本地 fallback / 检测能力, 真正的气泡识别 + 风格化贴回靠 `imageRule.mangaTranslator` 后端 API (默认 `auto`, 可选 openai / 自家)。

---

## Finding 1 — 网页双语对照 DOM 注入: `<font>` 包裹 + class 主题切换

**信息源**:
- 本地: `content_main.js` grep `immersive-translate-target-translation-block-wrapper` 命中 12 次, `notranslate` 命中 33 次
- 配置: `default_config.content.json/generalRule.targetWrapperTag = "font"`, `wrapperPrefix = "smart"`
- 公开分析: [manateelazycat 2023 反向](https://manateelazycat.github.io/2023/05/06/the-principle-of-immersive-translation/) (是早期开源版的复刻分析, 思路一致)

**代码 grep 结果**:
```
$ grep -oE 'immersive-translate-[a-z-]+' content_main.js | sort -u
immersive-translate-target-translation-block-wrapper
immersive-translate-target-translation-block-wrapper-theme-{background,blockquote,dashed,
  dividing,marker,paper,solid}
immersive-translate-target-translation-inline-wrapper-theme-{dashed,dividing,solid}
immersive-translate-target-translation-pdf-block-wrapper
immersive-translate-target-translation-pre-whitespace
immersive-translate-target-translation-theme-{background,bold,dashed,dotted,grey,
  highlight,italic}-{inner,}
```

**实现要点**:
- 用 `<font>` 而不是 `<span>` 是反直觉但是 brilliant — `<font>` 标签语义已弃用, 几乎不会撞到任何站点 CSS, 不破排版。同时浏览器仍当 inline 元素渲染。
- 块级译文外层是 `block-wrapper`, 行内译文外层是 `inline-wrapper`, 两套 theme class 让用户选 7 种视觉 (实线/虚线/点线/高亮/markdown 引用框 等)。
- 整个译文块标 `notranslate` 防止被 Google Translate 二次翻译。
- Pre-whitespace 节点 (`<pre>` / 代码块) 单独走 `translation-pre-whitespace` 保留空白。

**babata 必抄**:
- `<font>` 包裹策略 (而不是 `<span>` / Shadow DOM) — 0 风险破排版。
- 多 theme class + 一个 root 切换器 — 让用户选风格而不重写 DOM。

**babata 不抄**:
- 7 种 theme 是 over-engineering, MVP 阶段 1-2 种 (默认 + 可关) 即可。

---

## Finding 2 — 段落识别算法: 阈值 + 标签白/黑名单 + 站点 override

**信息源**: `default_config.content.json` 的 `generalRule` 下 ~140 个配置 key, 最关键的:

```python
generalRule = {
  # 段落判定阈值
  "paragraphMinTextCount": 2,        # 段内最少字符
  "paragraphMinWordCount": 1,        # 段内最少词
  "blockMinTextCount": 24,           # 升级为 block 的字符阈值
  "blockMinWordCount": 4,
  "mainFrameMinTextCount": 50,       # 整页能不能触发自动翻
  "longBuildDomLength": 3000,        # 长页面 lazy build

  # 标签级别 — 决定如何切段
  "inlineTags": ["A","ABBR","FONT","B","INS","DEL","RUBY","RP","RB","BDO","MARK","BIG",
                 "RT","CITE","DFN","EM","I","LABEL","Q","S","SMALL","SPAN","STRONG","SUB",
                 "SUP","U","KBD","TT","VAR","IMG","CODE","TIME", ...],
  "allBlockTags":  ["BODY","HGROUP","ARTICLE","ASIDE","DETAILS","BLOCKQUOTE","DD","DL","DT",
                    "FIGCAPTION","FIGURE","FOOTER","HEADER","FORM","MAIN","NAV","NOSCRIPT",
                    "PRE","SECTION","TABLE","TFOOT","UL","P","DIV","H1"-"H6","LI","OL", ...],

  # 排除/保留
  "excludeTags":    ["TITLE","LINK","SCRIPT","STYLE","TEXTAREA","SVG","NOSCRIPT","BASE",
                     "PRE","KBD","WBR","RT","MATH"],
  "stayOriginalTags": ["CODE","TT","IMG","SUP","SUB","SAMP","math","semantics","mrow",
                       "mo","mfrac","msup","mi","mn","msqrt","d-math"],
  "additionalStayOriginalSelectors": [".katex",".math-block",".MathJax",".mwe-math-element",
                                       ".ltx_Math","kbd","span.math.inline", ...],

  # 句末识别
  "lineBreakRegexStr": r"etc\.|Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|U\.S\.|U\.K\.|"
                       r"Co\.|Inc\.|Ltd\.|St\.",  # 缩写白名单防误切

  # 原子块 (整段当一个不可分割单位送翻)
  "atomicBlockSelectors": ["relin-hc","x-p","app-keyword-content"],
}
```

DOM 扫描走 `TreeWalker` (8 处) + `MutationObserver` (30 处, 用于动态页面) + `IntersectionObserver` (6 处, 用于视口惰性翻译)。

**babata 必抄**:
- 三档阈值 (`paragraphMin* < blockMin* < mainFrameMin*`) — 对应 inline / block / 整页, 干净。
- `stayOriginalTags` + 数学公式选择器列表 — 直接抄, 这是踩坑积累。
- `lineBreakRegexStr` 缩写白名单防误切句子 — 工程细节但很重要。

**babata 不抄**:
- `paragraphMinTextCount=2` 这种近乎不限的阈值是为了"宁可错翻也不漏" 的产品定位, babata 是 V 个人用, 可以放宽一点减少噪声。

---

## Finding 3 — 段落识别 #2: `siteParagraphCacheFallback` + 站点 rule 覆盖

**信息源**: `content_main.js` grep `siteParagraphCacheFallback` 命中 + 周边代码:

```js
function rk(e){return e.rule.siteParagraphCacheFallback?.enable!==!1}
function ik(e){return{
  maxAgeDay:  e.config.cacheMaxAgeDay,        // 默认 30 天
  maxEntries: e.rule.siteParagraphCacheFallback?.maxEntries,
  maxKB:      e.rule.siteParagraphCacheFallback?.maxKB
}}
async function sJ(e,t){let n=await Om(Nw(t),200);
  return n||!rk(e)?n:await BM(t,ik(e))}
```

每个站点的段落 hash → 译文是缓存的 (Nw(t) 是 hash 函数, 截断到 200 byte)。`storage` permission 用来存。

**babata 必抄**:
- 段落级缓存 (hash 短前缀) — 重访同站不重复翻, 对 LLM 翻译省钱明显。
- maxAgeDay/maxEntries/maxKB 三维 cap, 不让缓存爆。

---

## Finding 4 — PDF 翻译: 本地不渲染, 全部交服务端 (BabelDOC)

**信息源**:
- 本地 `pdf/index.html` 全文 + `pdf/extension-entry.js` 86 行 (基本未混淆!)
- 关联: [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) + [BabelDOC](https://github.com/funstory-ai/BabelDOC) 沉浸式赞助的开源项目

**关键代码** (`pdf/index.html`):
```html
<body>
  <iframe src="https://app.immersivetranslate.com/pdf?file=emptyfile"
          width="100%" style="min-height:100vh;border-width:0px"></iframe>
  <script src="./extension-entry.js"></script>
</body>
```

`pdf/extension-entry.js`:
```js
fetch(filePath).then(r => r.blob()).then(blob => {
  iframe.contentWindow.postMessage({
    type: "pdf-local-file",
    blob: blob,
    fileName: getDecodedFileName(filePath),
  }, "*");
});
```

**实现路径**: 扩展不内嵌 PDF.js / 不 hook chrome 内置 viewer。`isPdf=true` 时把 PDF URL 重定向到自家 viewer, viewer 是 iframe 跑 `app.immersivetranslate.com/pdf` (是 BabelDOC + PDFMathTranslate 引擎)。本地只做 4 件事: 抓文件 → 转 blob → postMessage 给 iframe → 显示 loading spinner。

排版保留全部在服务端: BabelDOC 用 layout detection + LLM 翻 + PDF 重渲染。免费有额度, 大文件需 Pro。

**babata 必抄**:
- "本地壳 + 远程引擎" 模式 — 排版级 PDF 翻译靠浏览器本地做不可能 (没人想自己实现 PDF reflow), 直接调 BabelDOC 服务 / 自家服务最合理。

**babata 不抄**:
- 把 viewer 锁死在自家域名是 vendor lock, babata 应该让 PDF backend 可配 (本地 BabelDOC docker / Mistral OCR / 自家 LLM API)。

---

## Finding 5 — Youtube 字幕翻译: hook XHR/fetch + 替换 .vtt response

**信息源**: `video-subtitle/inject.js` 完整 5KB 文件 (相对未混淆, 这个 dir 是 `web_accessible_resources` 单独 build)

**核心结构**:
```js
// 13 个站点 class 继承同一个基类 o, 各自 override
const stationMap = {
  youtube: b,         // hookType=xhr, 用 videoPlayerSelector 调 toggleSubtitles()
  netflix: S,         // hookJSON: 拦 JSON.parse 找 .timedtexttracks
  udemy: R,           // hookJSON: 拦 .asset.captions
  disneyplus: v,      // hookJSON: 拦 .stream.sources[0].complete.url
  hulu: M,            // 拦 fetch 取 transcripts_urls
  mubi: T,            // 拦 fetch 取 text_track_urls
  webvtt: o,          // 通用 .vtt 拦截
  general: o, ebutt: o, "fmp4.xml": o, multi_attach_vtt: w (TED), ...
};

// hookType=xhr 时:
XMLHttpRequest.prototype.open = function(){
  this._url = arguments[1];
  return origOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = async function(){
  if (s.isSubtitleRequest(this._url)) {            // regex 匹 subtitleUrlRegExp
    if (await s.isOnlyResponse()) {                // 流式
      this.onreadystatechange = async () => {
        if (this.readyState===4 && this.status===200)
          s.translateSubtitleWithResponse(this._url, this.responseText);
      };
    } else {
      await s.translateSubtitle(this);            // 直接改 responseText/responseXML
    }
  }
  return origSend.apply(this, arguments);
};
```

`subtitleRule` 站点级配置 (default_config.content.json):
- `hookType: "xhr"` / `"fetch"` / 两者
- `subtitleUrlRegExp`: 匹字幕请求
- `videoPlayerSelector` / `subtitleButtonSelector`: 自动开字幕按钮
- `translateGroupCount: 5` (5 句一组送翻, 提速 + 保上下文)
- `velocityGroup: [1,3,20]` (语速桶, 决定双语展示的对齐)
- `translationMode: "dual"` / `translationPosition: "bottom"`

**双语 cue 注入**: 不直接覆盖 `.ytp-caption-segment` DOM (会被 player 重绘冲掉), 而是替换原始 .vtt 响应里的 cue 内容, 让 player 自己用 TextTrack API 渲染。所以是"协议层"而不是"DOM 层" 注入。

**babata 必抄**:
- 协议层拦截 (XHR/fetch hook) > DOM 层覆盖 — 不和 player 内部 ReactDOM 战斗。
- `hookJSON()` 模式: 直接 monkey patch `JSON.parse` 抓元数据, 比 webRequest 拦更稳。
- 137 站点配置 list 直接抄过来, 不用自己一站站调研。

**babata 不抄**:
- 137 站点全做支持是 Pro 价值, MVP 只做 YouTube + Netflix + WebVTT 通用三件套已经够 80%。

---

## Finding 6 — Netflix 字幕: DRM 之外捡漏

**信息源**: `video-subtitle/inject.js` Netflix class:

```js
class S extends o {
  hookJSON() {
    const orig = JSON.parse;
    JSON.parse = (r) => {
      const e = orig(r);
      try {
        if (e?.result?.timedtexttracks && e.result.movieId) {
          this.videoMeta[e.result.movieId] = e.result;
          this.lastVideoMeta = e.result;
        }
      } catch {}
      return e;
    };
  }
}
```

Netflix 视频本身是 DRM (MSE/EME), 但**字幕 metadata 是普通 JSON**, 走 `manifest` 接口下发, 内含 `timedtexttracks: [{language, url, ...}]`。沉浸式只 hook `JSON.parse` 抓这个 metadata, 然后单独 fetch 字幕 URL (字幕本身是公开 .xml/.fmp4.xml, 没 DRM)。

**babata 必抄**:
- "DRM 防的是视频流, 字幕通常裸奔" 这个 insight 价值连城, MVP 也能抄。

---

## Finding 7 — 漫画翻译: Tesseract.js fallback + 服务端 manga API

**信息源**:
- `tesseract/` dir: tesseract.js 5.1.1 + 简体中文/英文模型, 总 8.8 MB wasm (`ReadMe` 标注 `unpkg.com/tesseract.js@5.1.1`)
- `content_main.js` 函数 `U$`:

```js
function U$(e, t, n, r, i = "manga") {
  const o = (e.rule.imageRule || {
    mangaTranslator: "openai",
    commonTranslator: "deepl"
  })[i + "Translator"];
  const s = j$(e.rule.imageRule, e.targetLanguage, o);
  const u = {
    imgHash: r,
    size: "M",
    detector: "auto",          // 气泡 / 文字检测
    translator: s.translator,
    direction: s.direction,    // ltr / rtl / vertical (日漫日文用)
    tgt_lang: s.lang,
    type: i                    // "manga" or "common"
  };
  const l = await oa(u);       // 调服务端
  ga({ sourceUrl: t, ... });
}
```

`imageRule` 配置:
```json
{
  "type": "common",
  "enableMangaFloatBall": true,
  "mangaTranslator": "auto",
  "commonTranslator": "bing",
  "imageTranslateProvider": "client",   // OCR 在浏览器
  "hoverMinWidth": 100, "hoverMinHeight": 100,
  "concurrency": 2, "queryIntervalTime": 1000,
  "clientOcrTimeout": 20000, "clientTranslateTimeout": 12000,
  "detectionServiceOrder": ["siliconcloud","google","bing","zhipu"],
  "removeTextRegexes": ["&#\\d+;","&amp;","\\.\\.\\.fp$","Yop$"],
  "replaceTextRegexes": [["[|1] ([a-zA-Z]+)","I $1"], ...]
}
```

**实现路径**:
1. 客户端 Tesseract.js 跑 OCR (有 `clientOcrTimeout=20000`, `noTranslateRegexes`, `removeTextRegexes` 这些后处理), 主要给"非漫画通用图片"用 (`commonTranslator:"bing"`)。
2. 漫画走 server: 把图片 hash 上传, 服务端做气泡识别 + OCR + 翻译 + 文字方向 + 风格化贴回 (`detector:"auto"`, `direction`, `size:"M"`)。OCR 后处理 regex (`replaceTextRegexes`) 修常见 OCR 错误 ("[|1] " → "I ", "TT$" → "。")。
3. Float ball UI 在 `enableMangaFloatBall=true` 时启用, hover 大于 100x100 的 `<img>` 触发。

**babata 必抄**:
- "通用图 OCR 在端 / 漫画走服务端" 分流 — 漫画气泡识别没有 multimodal LLM 一把搞不动, MVP 直接调 Claude/Gemini multimodal 不要本地 OCR。
- `removeTextRegexes` / `replaceTextRegexes` 后处理 list, 是 OCR 踩坑积累。

**babata 不抄**:
- 8.8 MB Tesseract wasm 包进扩展 — V 用 Claude multimodal 一个 API 全干, 不需要 OCR engine。

---

## Finding 8 — 翻译 backend: 30+ provider, 走 `request_modifier_rule` 改 referer

**信息源**:
- `manifest.json` `commands`: 11 个翻译服务的快捷键 (Bing, DeepL, Gemini, Google, OpenAI, Claude, Transmart, Custom1-3)
- `default_config.json` grep service id 数量: bing/google/deepl/deepseek/openai/claude/gemini 都各有 free/pro/custom 多档, 加上 baidu/caiyun/tencent/youdao/volc/qwen/transmart 共 30+
- `request_modifier_rule.json` 26 条 declarativeNetRequest 规则改 referer / origin / cookie

**实现要点**:
- Free tier 通过 declarativeNetRequest 改 referer 假装是从 deepl.com / google.com / bing.com 自家网站发起 (rule id 2: 改 deepl jsonrpc 的 Referer 为 `https://www.deepl.com/`, 移除 cookie)
- Claude/OpenAI 用户输 API key, 走自己后端
- Pro 订阅用沉浸式自家 gateway (default_config.json 有 `aigw1` host), 内含 LLM 调用 quota
- 流式: subtitleRule 里 `translateGroupCount` 控制 batch, AI subtitle 单段最大 `aiSubtitleMaxTextLength: 400`
- 缓存: `cacheMaxAgeDay=30` 天 + `maxEntries` + `maxKB` 三维 cap

**babata 必抄**:
- 通过 `declarativeNetRequest` 改 referer 白嫖 free tier 的思路 (虽然 ToS 灰)
- 自定义 OpenAI 兼容 endpoint (用户自己粘贴 url+key) — V 自建代理常用, 必须支持
- 段落级缓存 + 30 天清理
- 流式翻译 / batch 翻译 (一次塞多段进 prompt) — 对 Claude/OpenAI 显著省钱

---

## Finding 9 — 触发模式 + 配置入口

**信息源**: `manifest.json` commands + `default_config.json/translationStartMode`

**触发模式**:
- 默认 `translationStartMode: "dynamic"` — 进页面不自动翻, 按 Alt+A 触发当前页, Alt+W 翻整页
- `immediateTranslationPattern.matches/selectorMatches` — URL pattern / DOM selector 命中即自动翻 (默认空, 用户配 `medium://` 之类)
- `mouseHoverHoldKey` (Ctrl/Shift/Alt) + `mouseHoverPreferenceKey` (鼠标悬停翻段落)
- `mousePressHoldTranslateDelay` 按住 N ms 触发
- 选区翻译 `selectionTranslation` — 划词出小气泡
- Alt+S 开 side panel
- Alt+I 翻输入框内文本 (写英文邮件用)
- 触摸屏: `fingerCountToToggleTranslagePageWhenTouching` 三指 tap

**配置入口**:
- `popup.html` 弹窗快捷开关
- `options.html` 详细配置 (37KB JS)
- `side-panel.html` 侧边栏 AI 助手 + 阅读模式
- 用户的翻译服务通过 `options.js` 表单写入 chrome.storage

**babata 必抄**:
- Alt+A / Alt+W / Alt+S / Alt+I 4 个快捷键命名直接抄, 已有用户肌肉记忆
- 触发模式 4 件套: 自动 / 手动 / 划词 / 鼠标悬停 — MVP 必备
- side-panel + popup 双入口 — popup 做高频快开关, panel 做 AI 对话/长文交互

**babata 不抄**:
- 触摸屏手势在桌面 V 用不到, 删
- "鼠标悬停按 ms 数触发" 配置项太碎, MVP 用一个 hold-key (默认 Alt) 就够

---

## 附: babata-sidebar 借鉴清单 (一页流)

| 维度 | 抄 | 改 | 删 |
|---|---|---|---|
| DOM 注入 | `<font>` 包裹 + `notranslate` 防二翻 | theme 减到 1-2 种 | 7 种 theme class |
| 段落识别 | `inlineTags`/`stayOriginalTags`/`lineBreakRegexStr` 抄全 | 阈值放宽 (`paragraphMinTextCount` 5+) | — |
| 缓存 | hash + 30day + 3 维 cap | — | — |
| PDF | "本地壳 + 远程 BabelDOC" 模式 | 后端可配 (本地 docker/Mistral) | 锁死自家域 |
| 字幕 | XHR/fetch hook + JSON.parse hook + 协议层注入 | 137 站点砍到 YT+NF+WebVTT | 触摸屏手势 |
| Netflix | "DRM 之外字幕裸奔" 抓 timedtexttracks | — | — |
| 漫画 | server 端气泡识别, regex 后处理 list | 直接调 Claude multimodal, 不带 OCR engine | Tesseract.js wasm 8.8MB |
| Backend | 用户自定义 OpenAI 兼容 endpoint, batch 翻译 | — | declarativeNetRequest 改 referer 白嫖 (灰区) |
| 触发 | Alt+A/W/S/I, 4 模式 (auto/manual/select/hover) | hold-key 默认 Alt | 触摸屏 |

**核心 takeaway**: 沉浸式 v1.28.5 不是个 magic 黑盒, 而是 **143 个 generalRule 规则 + 137 个站点 override + 30+ 翻译 backend** 的硬堆积。babata-sidebar 直接复用前两个数据资产 (规则 + 站点 list) 就能跳过 90% 的踩坑成本; 真正要写的代码量 — 一个 TreeWalker + MutationObserver + XHR/fetch hook + `<font>` 注入器 — 不超过 2000 行。
