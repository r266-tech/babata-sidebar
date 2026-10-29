import DOMPurify from "dompurify";

const FORMATTING = new Set(["B", "STRONG", "I", "EM", "U", "S", "DEL", "MARK", "SMALL", "SUB", "SUP"]);
const TOKEN_RE = /\[\[(\/?)(BBT_(?:LINK|FMT|KEEP)_\d+)\]\]/g;
export interface SourcePlan {
  text: string;
  nodes: Map<string, HTMLElement>;
}
interface SourceRules {
  skip: (node: HTMLElement) => boolean;
  preserve: (node: HTMLElement) => boolean;
  block: (node: HTMLElement) => boolean;
}

// The provider receives text and opaque structural markers, never page HTML or
// protected code/math. The source nodes remain the only authority for markup.
export function encodeTranslationSource(root: HTMLElement, rules: SourceRules): SourcePlan {
  const nodes = new Map<string, HTMLElement>();
  const counts = { LINK: 0, FMT: 0, KEEP: 0 };
  const parts: string[] = [];
  const breakLine = () => { if (parts.length && !parts.at(-1)!.endsWith("\n")) parts.push("\n"); };
  const sourceText = (text: string) => {
    let offset = 0;
    // A page may discuss our marker syntax literally. Protect those strings as
    // source content so they cannot collide with this request's structural IDs.
    for (const match of text.matchAll(/\[\[\/?BBT_[\s\S]*?(?:\]\]|$)/g)) {
      parts.push(text.slice(offset, match.index));
      const literal = document.createElement("span");
      literal.textContent = match[0];
      const id = `BBT_KEEP_${++counts.KEEP}`;
      nodes.set(id, literal);
      parts.push(`[[${id}]]`);
      offset = match.index! + match[0].length;
    }
    parts.push(text.slice(offset));
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { sourceText(node.textContent || ""); return; }
    if (!(node instanceof HTMLElement)) return;
    if (rules.preserve(node)) {
      const id = `BBT_KEEP_${++counts.KEEP}`;
      nodes.set(id, node);
      parts.push(`[[${id}]]`);
      return;
    }
    if (rules.skip(node)) return;
    if (node.tagName === "BR") { parts.push("\n"); return; }
    const kind = node instanceof HTMLAnchorElement && node.hasAttribute("href") ? "LINK"
      : FORMATTING.has(node.tagName) ? "FMT" : null;
    const id = kind ? `BBT_${kind}_${++counts[kind]}` : "";
    if (id) { nodes.set(id, node); parts.push(`[[${id}]]`); }
    const block = rules.block(node);
    if (block) breakLine();
    for (const child of node.childNodes) visit(child);
    if (block) breakLine();
    if (id) parts.push(`[[/${id}]]`);
  };
  for (const node of root.childNodes) visit(node);
  return { text: parts.join("").replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(), nodes };
}

function cleanSourceClone(source: HTMLElement, deep: boolean): HTMLElement {
  const clone = source.cloneNode(deep) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    element.classList.remove("bbt-src", "bbt-tr", "bbt-tr-inplace");
    for (const attr of Array.from(element.attributes)) {
      if (attr.name === "id" || attr.name.startsWith("on") || attr.name.startsWith("data-bbt-")) element.removeAttribute(attr.name);
    }
  }
  if (clone instanceof HTMLAnchorElement && clone.target === "_blank") clone.rel = "noopener noreferrer";
  return clone;
}

export function renderTranslationMarkup(raw: string, plan: SourcePlan): string {
  // Old providers sometimes insert inline HTML between a marker pair. Flatten
  // that untrusted structure first, so a pair can span multiple returned nodes.
  const returned = document.createElement("template");
  returned.innerHTML = DOMPurify.sanitize(raw.replace(/<br\s*\/?\s*>/gi, "\n"), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  const text = returned.content.textContent || "";
  const output = document.createElement("div");
  const stack: Array<{ id: string; node: HTMLElement }> = [{ id: "", node: output }];
  const appendText = (value: string) => {
    const lines = value.split("\n");
    lines.forEach((line, index) => {
      if (index) stack.at(-1)!.node.append(document.createElement("br"));
      stack.at(-1)!.node.append(document.createTextNode(line));
    });
  };
  let offset = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    appendText(text.slice(offset, match.index));
    offset = match.index! + match[0].length;
    const [, closing, id] = match;
    const source = plan.nodes.get(id);
    if (!source) continue;
    if (closing) {
      let index = stack.length - 1;
      while (index > 0 && stack[index].id !== id) index--;
      if (index > 0) stack.splice(index);
    } else if (id.startsWith("BBT_KEEP_")) {
      stack.at(-1)!.node.append(cleanSourceClone(source, true));
    } else {
      const node = cleanSourceClone(source, false);
      stack.at(-1)!.node.append(node);
      stack.push({ id, node });
    }
  }
  appendText(text.slice(offset));
  return DOMPurify.sanitize(output.innerHTML);
}

// Split at sentence/word boundaries and balance formatting around each part.
// Repeated IDs are intentional: each part can be translated independently and
// reassembled without exposing code, losing spaces, or breaking nested links.
export function splitTranslationText(text: string, maxChars = 1400): string[] {
  const parts: string[] = [];
  const stack: string[] = [];
  const units = text.match(/\[\[\/?BBT_(?:LINK|FMT|KEEP)_\d+\]\]|[\s\S]/g) || [];
  let current = "";
  let textCount = 0;
  const finish = () => {
    if (!textCount) return;
    parts.push(current + [...stack].reverse().map((id) => `[[/${id}]]`).join(""));
    current = stack.map((id) => `[[${id}]]`).join("");
    textCount = 0;
  };
  for (const unit of units) {
    const token = /^\[\[(\/?)(BBT_(?:LINK|FMT|KEEP)_\d+)\]\]$/.exec(unit);
    current += unit;
    if (token) {
      if (token[1]) {
        const index = stack.lastIndexOf(token[2]);
        if (index >= 0) stack.splice(index);
      } else if (!token[2].startsWith("BBT_KEEP_")) stack.push(token[2]);
      else textCount += unit.length;
    } else textCount += unit.length;
    if (textCount >= maxChars && (/\s|[.!?。！？]/u.test(unit) || textCount >= maxChars + 100)) finish();
  }
  if (textCount || current && parts.length === 0) parts.push(current);
  return parts;
}
