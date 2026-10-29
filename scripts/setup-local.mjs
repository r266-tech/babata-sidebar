#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    if (command === npmBin() && process.env.npm_execpath) {
      commandArgs = [process.env.npm_execpath, ...commandArgs];
      command = process.execPath;
    }
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env,
      shell: process.platform === "win32" && command === "npm.cmd",
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} exited ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

async function pathExists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function accessExecutable(file) {
  try {
    await access(file, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function commandExists(name, env = process.env) {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
    return accessExecutable(name);
  }
  const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (await accessExecutable(candidate)) return true;
    }
  }
  return false;
}

export function companionOrigin(env = process.env) {
  const port = Number(env.BABATA_SIDEBAR_PORT || env.PORT || "18791");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Companion port must be an integer between 0 and 65535");
  if (port === 0) return null; // The actual port will be printed on startup.
  let host = env.BABATA_SIDEBAR_HOST || "127.0.0.1";
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  return new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`).origin;
}

export async function companionHealth(origin = companionOrigin()) {
  if (!origin) return null;
  try {
    const resp = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function printStep(text) {
  console.log(`\n==> ${text}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipInstall = args.has("--skip-install");
  const skipSmoke = args.has("--skip-smoke");
  const origin = companionOrigin();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (nodeMajor < 20) {
    console.error(`Node.js 20 or newer is required. Current: ${process.version}`);
    process.exit(1);
  }

  printStep("Checking local assistant CLIs");
  const [hasCodex, hasClaude, hasGrok] = await Promise.all([
    commandExists(process.env.BABATA_CODEX_CLI_PATH || process.env.CODEX_CLI_PATH || "codex"),
    commandExists(process.env.CLAUDE_CLI_PATH || process.env.BABATA_CLAUDE_CLI_PATH || "claude"),
    commandExists(process.env.BABATA_GROK_CLI_PATH || process.env.GROK_CLI_PATH || "grok"),
  ]);
  console.log(`Codex CLI: ${hasCodex ? "found" : "not found"}`);
  console.log(`Claude Code CLI: ${hasClaude ? "found" : "not found"}`);
  console.log(`Grok CLI: ${hasGrok ? "found" : "not found"}`);
  if (!hasCodex && !hasClaude && !hasGrok) {
    console.warn("Warning: sidebar chat needs `codex`, `claude`, or `grok` on PATH, or a CLI path override in the environment.");
  }

  if (!skipInstall) {
    printStep("Installing npm dependencies");
    await run(npmBin(), [await pathExists(path.join(root, "package-lock.json")) ? "ci" : "install"]);
  }

  printStep("Typechecking");
  await run(npmBin(), ["run", "typecheck"]);

  printStep("Building extension");
  await run(npmBin(), ["run", "build"]);

  if (!skipSmoke) {
    printStep("Running companion smoke test");
    await run(npmBin(), ["run", "smoke:companion"]);
  }

  if (!(await pathExists(path.join(root, "dist", "manifest.json")))) {
    console.error("Build did not create dist/manifest.json.");
    process.exit(1);
  }

  const health = await companionHealth(origin);

  console.log("\nSetup complete.");
  console.log("");
  console.log("Next steps:");
  console.log("1. Start the local companion and keep it running:");
  console.log("   npm run companion");
  console.log("2. In Chrome/Edge/Brave, open chrome://extensions or edge://extensions.");
  console.log("3. Enable Developer mode, click Load unpacked, and select this repo's dist/ directory.");
  console.log("4. Open the extension options page from the browser extension details/menu.");
  console.log(`5. Set Server URL to ${origin || "the listening URL printed by the companion after startup"}.`);
  console.log("6. Enter provider Base URL and API key in the options page, fetch/select or type a model, then Test and Save.");
  console.log("");
  if (health?.ok) {
    console.log(`Companion already running: ${health.label || health.cpu || "unknown"} at ${origin}`);
  } else {
    console.log("Companion is not running yet. Run `npm run companion` before using chat or translation.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
