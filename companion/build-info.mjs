import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Captured once at startup, so /health identifies the code actually loaded by
// this process even if the checkout is rebuilt while it is running.
const files = ["server.mjs", "translation-engine.mjs", "translation-scheduler.mjs", "transcription.mjs", "build-info.mjs"];
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file).update("\0").update(await readFile(new URL(file, import.meta.url))).update("\0");
}
const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
export const BUILD_INFO = Object.freeze({ version: metadata.version, source_sha256: hash.digest("hex") });
