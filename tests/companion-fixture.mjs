import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export async function startCompanion(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'babata-test-'));
  const program = path.join(dir, 'fake-cli.mjs');
  await writeFile(program, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const cpu = args[0] === 'exec' ? 'codex' : args.includes('--prompt-file') ? 'grok' : 'claude';
if (cpu === 'codex' && (args.includes('--ask-for-approval') || !args.includes('--ephemeral'))) process.exit(64);
const promptFile = cpu === 'grok' ? args[args.indexOf('--prompt-file') + 1] : null;
const prompt = fs.readFileSync(promptFile || 0, 'utf8');
fs.writeFileSync(process.env.TEST_INVOCATION_FILE, JSON.stringify({ cpu, promptFile, promptChars: prompt.length, argChars: args.join(' ').length }));
if (prompt.includes('EXIT_HELPER_TEST')) {
  const nested = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.TEST_PID_FILE, JSON.stringify([nested.pid]));
  nested.unref();
  console.log(cpu + ' fake reply');
} else if (prompt.includes('SLOW_TEST')) {
  const nested = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.TEST_PID_FILE, JSON.stringify([process.pid, nested.pid]));
  if (!prompt.includes('EXIT_PARENT_ON_STOP')) process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (prompt.includes('Browser tool results')) {
  console.log(prompt.includes('RESULT_FROM_B') ? 'RESULT_FROM_B' : 'TOOL_OK');
} else if (prompt.includes('USE_BROWSER_TOOL')) {
  console.log('<tool_call>{"action":"tab_metadata","args":{},"reason":"test"}</tool_call>');
} else if (prompt.includes('SMOKE_HISTORY_TOKEN')) {
  console.log('SMOKE_HISTORY_TOKEN');
} else {
  console.log(cpu + ' fake reply');
}
`, { mode: 0o700 });
  let executable = program;
  if (process.platform === 'win32') {
    executable = path.join(dir, 'fake-cli.cmd');
    await writeFile(executable, `@"${process.execPath}" "${program}" %*\r\n`);
  }
  const configPath = path.join(dir, 'config.json');
  const pidFile = path.join(dir, 'pids.json');
  const invocationFile = path.join(dir, 'invocation.json');
  const child = spawn(process.execPath, ['companion/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      BABATA_SIDEBAR_HOST: '127.0.0.1',
      BABATA_SIDEBAR_PORT: '0',
      BABATA_SIDEBAR_CONFIG: configPath,
      BABATA_SIDEBAR_DATA_DIR: dir,
      BABATA_CODEX_CLI_PATH: executable,
      CLAUDE_CLI_PATH: executable,
      BABATA_GROK_CLI_PATH: executable,
      BABATA_PROVIDER_TIMEOUT_MS: '300',
      TEST_PID_FILE: pidFile,
      TEST_INVOCATION_FILE: invocationFile,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let origin;
  try {
    origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('companion startup timed out')), 8000);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`companion exited ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/listening on (http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
  } catch (err) {
    child.kill();
    await rm(dir, { force: true, recursive: true });
    throw err;
  }
  function request(route, { client = 'browser-a', ...init } = {}) {
    return fetch(`${origin}${route}`, {
      ...init,
      headers: { origin: extensionOrigin, 'x-babata-client-id': client, ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(8000),
    });
  }
  const post = (route, body, init = {}) => request(route, {
    ...init, method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  return {
    dir, configPath, pidFile, invocationFile, origin, child, request, post,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
