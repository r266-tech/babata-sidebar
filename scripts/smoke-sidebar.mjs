const CDP = process.env.BABATA_EDGE_CDP || "http://127.0.0.1:9222";
const SERVER = process.env.BABATA_SIDEBAR_SERVER_ORIGIN || "http://127.0.0.1:18791";
const EXT_ID = process.env.BABATA_EXTENSION_ID || "giaglakcelnaklncmnhnpbmkfiffaflo";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const BAD_ORIGIN = "https://not-babata.invalid";
const TIMEOUT_MS = Number(process.env.BABATA_SMOKE_TIMEOUT_MS || "4000");

async function request(path, opts = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text in the failure detail.
  }
  return { res, text, json };
}

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function checkHealth() {
  const { res, json, text } = await request("/health");
  assert(res.status === 200, "health should allow no Origin", { status: res.status, text });
  assert(json?.ok === true, "health did not return ok:true", json);
  assert(json?.sw_attached === true, "service worker is not attached", json);
  return json;
}

async function checkOriginGuards() {
  const noOrigin = await request("/history?limit=1");
  assert(noOrigin.res.status === 403, "history should reject missing Origin", {
    status: noOrigin.res.status,
    body: noOrigin.json ?? noOrigin.text,
  });

  const badOrigin = await request("/history?limit=1", {
    headers: { Origin: BAD_ORIGIN },
  });
  assert(badOrigin.res.status === 403, "history should reject bad Origin", {
    status: badOrigin.res.status,
    body: badOrigin.json ?? badOrigin.text,
  });

  const allowed = await request("/history?limit=1", {
    headers: { Origin: EXT_ORIGIN },
  });
  assert(allowed.res.status === 200, "history should allow extension Origin", {
    status: allowed.res.status,
    body: allowed.json ?? allowed.text,
  });
  assert(
    allowed.res.headers.get("access-control-allow-origin") === EXT_ORIGIN,
    "allowed Origin should be echoed in CORS header",
    Object.fromEntries(allowed.res.headers.entries()),
  );
  return {
    no_origin_status: noOrigin.res.status,
    bad_origin_status: badOrigin.res.status,
    allowed_origin_status: allowed.res.status,
  };
}

async function checkEdgeExtension() {
  const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Edge CDP /json/list failed\n${JSON.stringify({
      status: res.status,
      text: await res.text(),
    }, null, 2)}`);
  }
  const targets = await res.json();
  const worker = targets.find((t) => t.type === "service_worker" && t.url.includes(EXT_ID));
  assert(worker, "babata extension service worker target not found", {
    extension_id: EXT_ID,
    targets: targets.map((t) => ({ type: t.type, url: t.url })),
  });
  return { type: worker.type, url: worker.url };
}

async function main() {
  const health = await checkHealth();
  const origin = await checkOriginGuards();
  const extension = await checkEdgeExtension();
  console.log(JSON.stringify({ ok: true, health, origin, extension }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
