import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/chat-debug-history.ts'], bundle: true, write: false, format: 'iife', globalName: 'historyBudget' });
const context = vm.createContext({});
vm.runInContext(bundle.outputFiles[0].text, context);
const { boundDebugPromptHistory, DEBUG_HISTORY_MAX_CHARS } = context.historyBudget;

await test('large debug histories preserve normal chat and recent prompts within one total budget', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: 'assistant', text: `Answer ${index}`,
    debug_prompts: [{ id: `prompt-${index}`, prompt: String(index).padStart(2, '0') + 'x'.repeat(239_998), chars: 240_000 }],
  }));
  const limited = boundDebugPromptHistory(messages);
  const chars = limited.reduce((count, message) => count + message.debug_prompts.reduce((n, trace) => n + trace.prompt.length, 0), 0);
  assert.ok(chars <= DEBUG_HISTORY_MAX_CHARS);
  assert.deepEqual(Array.from(limited, (message) => message.text), messages.map((message) => message.text));
  assert.equal(limited.at(-1).debug_prompts[0].prompt, messages.at(-1).debug_prompts[0].prompt);
  assert.equal(limited[0].debug_prompts[0].truncated, true);
  assert.match(limited[0].debug_prompts[0].prompt, /已省略/);
  assert.equal(limited[0].debug_prompts[0].chars, 240_000);
  assert.equal(messages[0].debug_prompts[0].truncated, undefined);
});

await test('small prompt histories keep their complete content unchanged', () => {
  const messages = [{ text: 'answer', debug_prompts: [{ prompt: 'short prompt', chars: 12 }] }];
  assert.equal(JSON.stringify(boundDebugPromptHistory(messages)), JSON.stringify(messages));
});
