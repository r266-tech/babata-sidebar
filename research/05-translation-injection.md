# 翻译/视频/PDF/OCR 注入技术深挖

## 总览

babata-sidebar 替代沉浸式翻译 + openclaw-sidebar 的核心难点不在 LLM, 而在**浏览器侧把译文塞回页面**. 9 个 finding 拆开看, 难度梯度:

| 场景 | 难度 | 推荐栈 |
|------|------|--------|
| 网页 inline 双语 | 中 | DOM 直接注入 + IntersectionObserver 懒加载 + Shadow DOM 仅给浮层 |
| 选区翻译 | 低 | selectionchange + Shadow DOM 浮层 |
| Youtube 字幕 | 中 | innertube `/youtubei/v1/player` 拿 baseUrl + json3 + DOM 同步替换 `.ytp-caption-segment` |
| Netflix 字幕 | 高 | DOM hook `.player-timedtext` (DRM 不影响渲染层) + 兜底 tabCapture+ASR |
| iframe / cross-origin | 低 | `all_frames: true` + `match_about_blank` + postMessage |
| PDF 双语 | 高 | declarativeNetRequest redirect 到 PDF.js fork (内置 viewer 不可注入) |
| 图片 OCR (漫画) | 中 | 一步直调多模态 LLM 返回 `{boxes,text}`, 跳过 OCR+翻译两阶段 |
| 视频自动翻译 | 高 | tabCapture → offscreen document → ASR 流 → addTextTrack cue |
| 翻译 API 接入 | 低 | 全走 babata server `/sidebar/translate` SSE, 守 one-CPU 铁律 |

V0 必做: 1, 2, 7, 9. V1 必做: 3, 5. V2 选做: 4, 6, 8.

---

## Finding 1: 网页 inline 双语注入 — DOM 直接插入 + 段落感知

**难点**: 5000 段长页 (维基/arxiv/技术文档), 一次全译 token 爆炸 + 排版抖动. 段落 boundary 难定 (`<div>` 嵌套 / `<span>` 行内). 注入后 layout shift, 影响阅读. 用户 ⌘A 复制要不要拿到译文也要决策.

**主流方案对比**:

| 方案 | 排版稳定性 | 性能 | 选中行为 | 关闭难度 |
|------|----------|------|---------|---------|
| DOM 直接注入 `<p>原</p><p class="bbt-tr">译</p>` | 高 (新元素自然 flow) | 中 (需遍历 + 翻译) | 一起选 ✓ | 易 (remove class) |
| Shadow DOM 包译文 | 极高 (样式隔绝) | 低 (shadow root 多了 GC 重) | 不一起选 ✗ | 易 |
| `::after content` | 低 (pseudo 不能换行块级) | 高 | 不可选 ✗ | 易 |
| `<ruby>` 行内注音 | 中 (撑高行高) | 中 | 一起选 ✓ | 中 |

沉浸式翻译实测用方案 1 (DOM 直接注入 + 自定义 `<font class="notranslate immersive-translate-target-translation-block-wrapper">`). 跟 Firefox Translations 撞 shadow DOM 兼容 bug ([bug 1841656](https://bugzilla.mozilla.org/show_bug.cgi?id=1841656)) 印证: 大规模翻译注入应避免给每段都开 shadow root.

**babata 推荐**: 主体走 DOM 直接注入. Shadow DOM 只用于 UI 浮层 (选区翻译框 / sidebar). IntersectionObserver 懒加载, 视口外不调 LLM.

```js
// content/inject-bilingual.js
const TRANSLATABLE = 'p,h1,h2,h3,h4,li,blockquote,td,figcaption';
const io = new IntersectionObserver(async (entries) => {
  const visible = entries.filter(e => e.isIntersecting && !e.target.dataset.bbtDone);
  if (!visible.length) return;
  const texts = visible.map(e => e.target.innerText.trim()).filter(Boolean);
  const translations = await chrome.runtime.sendMessage({ type: 'translate', texts });
  visible.forEach((e, i) => {
    e.target.dataset.bbtDone = '1';
    const tr = document.createElement('div');
    tr.className = 'bbt-tr';  // 用户 toggle 时 .bbt-off .bbt-tr { display:none }
    tr.lang = 'zh-CN';
    tr.textContent = translations[i];  // textContent, 杜绝 XSS
    e.target.insertAdjacentElement('afterend', tr);
  });
}, { rootMargin: '200px' });
document.querySelectorAll(TRANSLATABLE).forEach(el => io.observe(el));
```

---

## Finding 2: 选区翻译 (划词) — Shadow DOM 浮层

**难点**: 页面自定义 z-index 高到 2147483647, 浮层被盖. 选区跨段落 bounding rect 不规则. 用户拖选未结束时不能弹.

**主流方案**: `selectionchange` event + `Selection.getRangeAt(0).getBoundingClientRect()`. Shadow DOM 隔离样式不被覆盖. 沉浸式 / Trancy / DeepL extension 全都用这套.

**babata 推荐**: Shadow root 内部全用 DOM API 构建, 不走 innerHTML, 用户输入永远 textContent.

```js
// content/selection-popup.js
const host = document.createElement('div');
host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0';
document.documentElement.appendChild(host);
const root = host.attachShadow({ mode: 'closed' });
const style = document.createElement('style');
style.textContent = ':host{all:initial}.box{background:#fff;border:1px solid #ccc;padding:8px;border-radius:6px;font:13px/1.5 system-ui;max-width:380px}';
const box = document.createElement('div');
box.className = 'box'; box.hidden = true;
root.append(style, box);

let timer;
document.addEventListener('selectionchange', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const sel = getSelection();
    const text = sel.toString().trim();
    if (!text || text.length > 500) { box.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    host.style.transform = `translate(${rect.left}px,${rect.bottom + 6}px)`;
    box.hidden = false; box.textContent = '...';
    box.textContent = await translateOne(text);  // textContent only
  }, 200);  // debounce, 拖选未结束不弹
});
```

---

## Finding 3: Youtube 字幕翻译 — innertube + DOM 同步

**难点**: MV3 废了 `webRequestBlocking`, 不能拦 .vtt 改内容. `declarativeNetRequest` 能 redirect 但不能动态注入翻译后的内容 (规则要静态). YouTube 已禁止裸 `api/timedtext?lang=en&v=ID`, 必须用签过名的 baseUrl ([UltronOne/youtube-timedtext-api](https://github.com/UltronOne/youtube-timedtext-api)).

**主流方案** (沉浸式 / Trancy 实测):
1. 走 innertube `POST /youtubei/v1/player`, body 带 video_id + INNERTUBE_CONTEXT, 解 `captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`
2. baseUrl 加 `&fmt=json3`, fetch 拿 `events:[{tStartMs,dDurationMs,segs:[{utf8}]}]`
3. 整批译完缓存
4. 注入: 两选一 — 监听 `<video>.timeupdate` 找到当前 cue, DOM 替换 `.ytp-caption-segment` 文本; 或 `video.addTextTrack('subtitles')` 然后 `track.addCue(new VTTCue(start,end,bilingualText))` 让浏览器自己渲染

**babata 推荐**: 替换 `.ytp-caption-segment` 直观可控, 排版用 YT 自家样式. addTextTrack 在某些 YT player 改版后会被原生轨道覆盖, 不稳.

```js
// content/youtube-subs.js
async function getCaptions(videoId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20251101.00.00' } } })
  });
  const data = await r.json();
  const track = data.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  if (!track) return null;
  const cues = await fetch(track.baseUrl + '&fmt=json3').then(x => x.json());
  return cues.events.filter(e => e.segs).map(e => ({
    t0: e.tStartMs / 1000, t1: (e.tStartMs + e.dDurationMs) / 1000,
    text: e.segs.map(s => s.utf8).join('')
  }));
}
// 启动后预译, 监听 video.timeupdate, 找到当前 cue. 替换字幕段时用 textContent 写入两行 (br 用 createElement), 不拼 innerHTML.
```

---

## Finding 4: Netflix 字幕 — DRM 影响传输不影响渲染

**难点**: TTML/DFXP 走 Widevine 加密轨, fetch 拦不到 raw text. 但**渲染层不加密** — Netflix 把字幕画到 `.player-timedtext > .player-timedtext-text-container > span` 里, JS 完全可读.

**主流方案**:
- (a) DOM hook `.player-timedtext` MutationObserver, 译后替换/追加. 沉浸式实测就这么做的 ("检测 Netflix 原生字幕自动叠加翻译").
- (b) tabCapture + Whisper ASR, DRM 不影响 ([recall.ai 架构](https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension)). 实时性 1-2s 延迟.
- (c) 用户提供 srt 手动喂.

**babata 推荐**: V0 不做 Netflix, V2 做方案 a. ASR 兜底 V3.

```js
// content/netflix-subs.js  (V2)
const obs = new MutationObserver(async (records) => {
  for (const r of records) {
    const container = r.target.closest?.('.player-timedtext-text-container');
    if (!container || container.dataset.bbtDone) continue;
    const original = container.innerText.trim();
    if (!original) continue;
    container.dataset.bbtDone = '1';
    const zh = await translateOne(original);
    const trEl = document.createElement('span');
    trEl.className = 'bbt-nf-tr';
    trEl.textContent = zh;
    container.appendChild(document.createElement('br'));
    container.appendChild(trEl);
  }
});
obs.observe(document.body, { childList: true, subtree: true, characterData: true });
```

---

## Finding 5: PDF 双语 — redirect 到自家 viewer

**难点**: chrome 内置 PDF viewer 是 `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`, MV3 content_scripts.matches 不支持 chrome-extension:// 协议, 沙箱阻止注入 ([MDN content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/executeScript)).

**主流方案**:
- (a) declarativeNetRequest redirect `*.pdf` → 我们打包的 PDF.js fork. 失去 chrome 原生体验但完全可控.
- (b) 服务端 [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) — 222k+ 下载, 保公式/表格/排版, CLI/MCP/Docker 都有. 用户上传 PDF, babata server 调用, 返回双语 PDF 文件. **失去 inline 双语体验**, 但工程最简.
- (c) DOM 注入到 chrome 内置 viewer: 实测不行.

**babata 推荐**: V1 走方案 a (PDF.js fork) 做 inline 双语 + 划词. V2 集成 PDFMathTranslate 作为 "导出双语 PDF" 重型选项.

```json
// rules.json (declarativeNetRequest)
[{
  "id": 1,
  "priority": 1,
  "action": { "type": "redirect", "redirect": {
    "regexSubstitution": "chrome-extension://EXTID/pdfjs/viewer.html?file=\\0"
  }},
  "condition": { "regexFilter": "^https?://.*\\.pdf(\\?.*)?$", "resourceTypes": ["main_frame"] }
}]
```

PDF.js fork 改: 文本层 (`textLayer`) 渲染时段落聚合 + 调 babata 翻译 API, 译文画到独立 `<canvas>` 浮层, 跟原文坐标对齐. (运行时用 `chrome.runtime.getURL` 替换 `EXTID`.)

---

## Finding 6: 图片 OCR + 翻译 (漫画) — 一步多模态

**难点**: 漫画气泡形状不规则 / 拟声词 / 竖排日文 / 字体匹配. OCR + 翻译两步累积误差.

**主流方案对比**:

| 引擎 | 部署 | 成本 | 质量 | 漫画支持 |
|------|------|------|------|---------|
| PaddleOCR (本地) | 服务端 GPU | 免费 | 中文好 | 弱 (无气泡检测) |
| Tesseract.js (wasm) | 浏览器 | 免费 | 一般 | 差 |
| 多模态 LLM (Gemini-3.1-flash / Claude Sonnet 4.6 / mimo-omni) | API | 中 | 强 | 强 (空间理解) |

[ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) 已经走 GPT-4.1/Claude-4.5/Gemini-2.5 全页 + 上下文. [UGTLive](https://github.com/SethRobinson/UGTLive) 把 rect 信息一起喂 LLM, 让它跨气泡决策. [koharu](https://github.com/mayocream/koharu) 走多模型 pipeline (检测 → OCR → inpaint → 翻译).

**babata 推荐**: 一步直调多模态 LLM 返回结构化 `{boxes, text}`. 比两步 OCR+翻译省 token + 质量更高, 跟 V 2026-04 discoverative 加固经验对齐 (省得 silent fallback).

```js
// content/manga-ocr.js
async function translateImage(imgEl) {
  const dataUrl = await imgToDataUrl(imgEl);
  const result = await chrome.runtime.sendMessage({
    type: 'vision-translate',
    image: dataUrl,
    prompt: '漫画英->中. 返回 JSON {boxes:[{x,y,w,h,text_zh}]}, 坐标百分比 0-1. 保留拟声词原文 + 中文括号注. 竖排日文按行序.'
  });
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:absolute;top:${imgEl.offsetTop}px;left:${imgEl.offsetLeft}px;width:${imgEl.offsetWidth}px;height:${imgEl.offsetHeight}px;pointer-events:none`;
  result.boxes.forEach(b => {
    const span = document.createElement('span');
    span.style.cssText = `position:absolute;left:${b.x*100}%;top:${b.y*100}%;width:${b.w*100}%;height:${b.h*100}%;background:rgba(255,255,255,.9);font-size:12px;text-align:center;display:flex;align-items:center;justify-content:center`;
    span.textContent = b.text_zh;
    overlay.appendChild(span);
  });
  imgEl.parentElement.appendChild(overlay);
}
```

---

## Finding 7: iframe / cross-origin — manifest 一行配齐

**难点**: 同源父子直接调函数, 跨源只能 postMessage. 部分网站给 iframe `sandbox` 属性禁脚本.

**主流方案**: `content_scripts: { all_frames: true, match_about_blank: true }` 让脚本注入到所有同 match 的 frame. 跨源加 `host_permissions: ["<all_urls>"]`. sandbox iframe 禁脚本时 chrome 会跳过注入, 没办法绕 — 这种 iframe 通常是广告, 不译也罢.

**babata 推荐**:

```json
{
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "all_frames": true,
    "match_about_blank": true,
    "js": ["content/inject-bilingual.js"],
    "run_at": "document_idle"
  }],
  "host_permissions": ["<all_urls>"]
}
```

frame 间通讯: `window.parent.postMessage({source:'bbt', type:'translate-done', count:n}, '*')`, 父 frame 用 `messageEvent.source` 验证.

---

## Finding 8: 视频自动翻译 (无字幕) — tabCapture + offscreen + ASR

**难点**: MV3 service worker 无 DOM, 不能跑 MediaStream. 必须用 `chrome.offscreen.createDocument()` 起一个隐藏 DOM context. 实时性: ASR 延迟 1-2s, 跟视频时间轴对不齐用户体验差.

**主流方案**: [recall.ai 架构](https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension) — popup 触发 → background 拿 streamId → offscreen document `getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}}})` → MediaRecorder 切 chunk → WebSocket 推 Whisper/mimo-omni → 回写 cue.

**babata 推荐**: V2 选做. 用 `video.addTextTrack` 注入, 浏览器原生渲染.

```js
// offscreen.js
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== 'start-asr') return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    video: false
  });
  const ws = new WebSocket('wss://babata.local/sidebar/asr');
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = e => e.data.size && ws.send(e.data);
  ws.onmessage = ev => {
    const { t0, t1, text } = JSON.parse(ev.data);
    chrome.runtime.sendMessage({ type: 'asr-cue', t0, t1, text });  // content script 调 addTextTrack
  };
  recorder.start(500);  // 每 500ms 一个 chunk
});
```

---

## Finding 9: 翻译 API 接入 — 全走 babata server (one CPU 铁律)

**难点**: 浏览器扩展直调 OpenRouter / Anthropic API 快 + 便宜, 但**直接破 one-CPU 铁律** ([feedback_one_cpu_many_channels.md](memory)). babata 全部 channel 必须走同一个 CC binary.

**主流方案**: 走 babata server `/sidebar/translate` SSE endpoint, 后端 cc.py spawn CC subprocess (跟 TG/微信 channel 同构). 复用 channel-agnostic cc.py.

**babata 推荐**: 全走 server. 流式 markdown 用 SSE.

```js
// background/translate.js
async function* translateStream(texts) {
  const r = await fetch('https://babata.local/sidebar/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ texts, target: 'zh-CN', stream: true })
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (evt.startsWith('data: ')) yield JSON.parse(evt.slice(6));
    }
  }
}
```

server 侧 (FastAPI 伪代码):

```python
@app.post('/sidebar/translate')
async def translate(req: Req):
  async def gen():
    async for chunk in cc.stream(prompt=f"翻译到 {req.target}: {req.texts}", source='sidebar'):
      yield f"data: {json.dumps(chunk)}\n\n"
  return StreamingResponse(gen(), media_type='text/event-stream')
```

---

## V0 / V1 / V2 分级

**V0 (MVP, 跟 openclaw-sidebar 持平 + 网页双语)**:
- F1 网页 inline 双语
- F2 选区翻译
- F7 iframe 注入
- F9 babata server endpoint

**V1 (替代沉浸式翻译核心场景)**:
- F3 Youtube 字幕
- F5 PDF (PDF.js fork redirect)

**V2 (差异化能力, 沉浸式部分支持)**:
- F4 Netflix 字幕
- F6 漫画 OCR
- F8 无字幕视频 ASR

---

## Sources

- [Immersive Translate FAQ](https://immersivetranslate.com/en/docs/faq/)
- [Trancy bilingual subtitles](https://www.trancy.org/)
- [chrome.declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Replace blocking webRequest listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)
- [chrome.tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [recall.ai MV3 recording architecture](https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension)
- [comic-translate](https://github.com/ogkalu2/comic-translate)
- [koharu manga translator](https://github.com/mayocream/koharu)
- [UGTLive (LLM 空间理解)](https://github.com/SethRobinson/UGTLive)
- [youtube-timedtext-api](https://github.com/UltronOne/youtube-timedtext-api)
- [Innertube transcript JS guide](https://medium.com/@aqib-2/extract-youtube-transcripts-using-innertube-api-2025-javascript-guide-dc417b762f49)
- [Firefox Translations × Shadow DOM bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1841656)
- [MDN Content scripts (PDF viewer 限制)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/executeScript)
