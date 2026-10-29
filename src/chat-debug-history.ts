// Debug prompts repeat the model context and can otherwise dwarf the actual
// conversation. Keep recent prompts, preserving a visible marker on older ones.
export const DEBUG_HISTORY_MAX_CHARS = 1_000_000;
const OMITTED_PROMPT = "[历史调试提示已省略，以控制本地存储大小]";

type DebugHistoryMessage = {
  debug_prompts?: Array<{ prompt: string; truncated?: boolean }>;
};

export function boundDebugPromptHistory<T extends DebugHistoryMessage>(messages: T[]): T[] {
  const traces = messages.reduce((count, message) => count + (message.debug_prompts?.length ?? 0), 0);
  let remaining = DEBUG_HISTORY_MAX_CHARS;
  let remainingTraces = traces;
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const prompts = result[i].debug_prompts;
    if (!prompts?.length) continue;
    const next = [...prompts];
    for (let j = next.length - 1; j >= 0; j -= 1) {
      remainingTraces -= 1;
      const trace = next[j];
      const available = Math.max(OMITTED_PROMPT.length, remaining - remainingTraces * OMITTED_PROMPT.length);
      if (trace.prompt.length > available) {
        const prompt = available === OMITTED_PROMPT.length ? OMITTED_PROMPT : trace.prompt.slice(0, available);
        next[j] = { ...trace, prompt, truncated: true };
      }
      remaining -= next[j].prompt.length;
    }
    result[i] = { ...result[i], debug_prompts: next };
  }
  return result;
}
