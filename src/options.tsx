import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TranslationModelOption, TranslationProviderSettings } from "./runtime-config";
import {
  DEFAULT_SERVER_ORIGIN,
  getServerOrigin,
  normalizeServerOrigin,
  resolveReachableServerOrigin,
  serverUrlFromOrigin,
  setServerOrigin as persistServerOrigin,
} from "./runtime-config";

type ServerHealth = {
  ok?: boolean;
  cpu?: string;
  label?: string;
  choices?: Array<{ name: string; label: string; current?: boolean }>;
};

const DEFAULT_PROVIDER: TranslationProviderSettings = {
  base_url: "https://openrouter.ai/api/v1",
  model: "",
  api_key_set: false,
};

function textField(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object") return "";
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function normalizeProvider(value: unknown): TranslationProviderSettings {
  if (!value || typeof value !== "object") return DEFAULT_PROVIDER;
  const apiKey = textField(value, "api_key");
  return {
    base_url: textField(value, "base_url") || DEFAULT_PROVIDER.base_url,
    model: textField(value, "model"),
    ...(apiKey ? { api_key: apiKey } : {}),
    api_key_set: (value as Record<string, unknown>).api_key_set === true,
  };
}

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  const data = await resp.json().catch(() => null);
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function App() {
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_ORIGIN);
  const [serverOrigin, setServerOrigin] = useState(DEFAULT_SERVER_ORIGIN);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  const [serverStatus, setServerStatus] = useState("未检测");
  const [provider, setProvider] = useState<TranslationProviderSettings>(DEFAULT_PROVIDER);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<TranslationModelOption[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [providerStatus, setProviderStatus] = useState("未检测");
  const [busy, setBusy] = useState<string | null>(null);
  const checkServerSeq = useRef(0);

  const currentServerUrl = useMemo(() => normalizeServerOrigin(serverInput), [serverInput]);

  async function serverRequest(path: string, init?: RequestInit): Promise<Response> {
    const reachable = await resolveReachableServerOrigin(currentServerUrl);
    if (reachable !== currentServerUrl) {
      setServerInput(reachable);
      setServerOrigin(reachable);
    }
    return fetch(serverUrlFromOrigin(reachable, path), init);
  }

  async function loadServerSettings(origin = currentServerUrl) {
    const resp = await fetch(serverUrlFromOrigin(origin, "/settings"));
    const data = await readJson(resp);
    if (!resp.ok || data.ok !== true) throw new Error(textField(data, "error") || `HTTP ${resp.status}`);
    const nextProvider = normalizeProvider(data.translation_provider);
    setProvider(nextProvider);
    setApiKey(nextProvider.api_key || "");
    setModelInput(nextProvider.model);
    setProviderStatus(nextProvider.api_key_set ? "已保存 API key" : "未配置 API key");
  }

  async function checkServer(origin = currentServerUrl) {
    const seq = checkServerSeq.current + 1;
    checkServerSeq.current = seq;
    setBusy("server");
    setServerStatus("检测中...");
    try {
      const normalized = normalizeServerOrigin(origin);
      const reachable = await resolveReachableServerOrigin(normalized);
      if (seq !== checkServerSeq.current) return;
      if (reachable !== normalized) {
        setServerInput(reachable);
        setServerOrigin(reachable);
      }
      const resp = await fetch(serverUrlFromOrigin(reachable, "/health"));
      const data = await readJson(resp);
      if (!resp.ok || data.ok !== true) throw new Error(textField(data, "error") || `HTTP ${resp.status}`);
      if (seq !== checkServerSeq.current) return;
      setServerHealth(data as ServerHealth);
      setServerStatus(reachable === normalized ? "已连接" : "已连接，已自动切回默认端口");
      await loadServerSettings(reachable);
    } catch (e) {
      if (seq !== checkServerSeq.current) return;
      setServerHealth(null);
      setServerStatus((e as Error).message || String(e));
    } finally {
      if (seq === checkServerSeq.current) setBusy(null);
    }
  }

  useEffect(() => {
    void (async () => {
      const origin = await resolveReachableServerOrigin(await getServerOrigin());
      setServerInput(origin);
      setServerOrigin(origin);
      await checkServer(origin);
    })();
  }, []);

  async function saveServer() {
    setBusy("server");
    const normalized = await persistServerOrigin(serverInput);
    setServerInput(normalized);
    setServerOrigin(normalized);
    setBusy(null);
    await checkServer(normalized);
  }

  function providerPayload(includeKey: boolean) {
    const model = modelInput.trim();
    return {
      base_url: provider.base_url.trim(),
      ...(includeKey ? { api_key: apiKey.trim() } : {}),
      ...(model ? { model } : {}),
    };
  }

  async function fetchModels() {
    setBusy("models");
    setProviderStatus("读取模型中...");
    try {
      const resp = await serverRequest("/translate/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(providerPayload(true)),
      });
      const data = await readJson(resp);
      if (!resp.ok || data.ok !== true) throw new Error(textField(data, "error") || `HTTP ${resp.status}`);
      const nextModels = Array.isArray(data.models)
        ? (data.models as unknown[])
          .filter((item): item is TranslationModelOption => (
            !!item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ))
          .slice(0, 300)
        : [];
      setModels(nextModels);
      setProviderStatus(nextModels.length > 0 ? `读取到 ${nextModels.length} 个模型` : "接口可用，但没有返回模型列表");
    } catch (e) {
      setProviderStatus((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function testProvider() {
    setBusy("test");
    setProviderStatus("测试翻译中...");
    try {
      const translated = await runProviderTest();
      setProviderStatus(`测试通过: ${translated || "ok"}`);
    } catch (e) {
      setProviderStatus((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runProviderTest(): Promise<string> {
    const resp = await serverRequest("/translate/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(providerPayload(true)),
    });
    const data = await readJson(resp);
    if (!resp.ok || data.ok !== true) throw new Error(textField(data, "error") || `HTTP ${resp.status}`);
    return textField(data, "translated");
  }

  async function saveProvider() {
    setBusy("save");
    setProviderStatus("保存前测试中...");
    try {
      const translated = await runProviderTest();
      setProviderStatus("保存中...");
      const resp = await serverRequest("/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translation_provider: providerPayload(true) }),
      });
      const data = await readJson(resp);
      if (!resp.ok || data.ok !== true) throw new Error(textField(data, "error") || `HTTP ${resp.status}`);
      const nextProvider = normalizeProvider(data.translation_provider);
      setProvider(nextProvider);
      setModelInput(nextProvider.model);
      setApiKey(nextProvider.api_key || apiKey);
      setProviderStatus(`已保存并测试通过: ${translated || "ok"}`);
    } catch (e) {
      setProviderStatus((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main>
      <header>
        <img src="icons/babata-48.png" alt="" />
        <div>
          <h1>babata settings</h1>
          <p>Configure the local companion and translation provider.</p>
        </div>
      </header>

      <section>
        <div class="section-head">
          <h2>Local Companion</h2>
          <span class={serverStatus === "已连接" ? "ok" : "warn"}>{serverStatus}</span>
        </div>
        <label>
          <span>Server URL</span>
          <input
            value={serverInput}
            onInput={(e) => setServerInput((e.currentTarget as HTMLInputElement).value)}
            placeholder="http://127.0.0.1:18791"
          />
        </label>
        <div class="row">
          <button onClick={saveServer} disabled={busy === "server"}>Save & Detect</button>
          <button onClick={() => checkServer()} disabled={busy === "server"}>Detect</button>
        </div>
        <p class="meta">
          Active: {serverOrigin}. CPU: {serverHealth?.label || serverHealth?.cpu || "unknown"}.
        </p>
      </section>

      <section>
        <div class="section-head">
          <h2>Translation Provider</h2>
          <span class={providerStatus.startsWith("测试通过") || providerStatus.startsWith("已保存并测试通过") ? "ok" : "warn"}>
            {providerStatus}
          </span>
        </div>
        <label>
          <span>Base URL</span>
          <input
            value={provider.base_url}
            onInput={(e) => setProvider({ ...provider, base_url: (e.currentTarget as HTMLInputElement).value })}
            placeholder="https://openrouter.ai/api/v1"
          />
        </label>
        <label>
          <span>API key</span>
          <div class="secret-row">
            <input
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onInput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)}
              placeholder="sk-..."
            />
            <button
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
              onClick={() => setShowApiKey(!showApiKey)}
              disabled={!apiKey}
            >
              {showApiKey ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <label>
          <span>Model</span>
          <input
            list="models"
            value={modelInput}
            onInput={(e) => setModelInput((e.currentTarget as HTMLInputElement).value)}
            placeholder="Select or type a model id"
          />
          <datalist id="models">
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.id}
              </option>
            ))}
          </datalist>
        </label>
        <div class="row">
          <button onClick={fetchModels} disabled={busy !== null}>Fetch Models</button>
          <button onClick={testProvider} disabled={busy !== null || !modelInput.trim()}>Test</button>
          <button class="primary" onClick={saveProvider} disabled={busy !== null || !modelInput.trim()}>
            Save Provider
          </button>
        </div>
      </section>
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root {
    color: #1c1c1c;
    background: #f7f5f1;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body { margin: 0; }
  main { width: min(760px, calc(100vw - 40px)); margin: 32px auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
  header img { width: 42px; height: 42px; border-radius: 8px; }
  h1 { margin: 0; font-size: 24px; line-height: 1.2; }
  header p { margin: 4px 0 0; color: #6d6760; }
  section {
    background: #fff;
    border: 1px solid rgba(0,0,0,.08);
    border-radius: 8px;
    padding: 18px;
    margin: 14px 0;
    box-shadow: 0 8px 24px rgba(0,0,0,.05);
  }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  h2 { margin: 0; font-size: 16px; }
  .ok, .warn {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    border-radius: 999px;
    padding: 4px 9px;
  }
  .ok { background: #e4f4e9; color: #1f6f3d; }
  .warn { background: #f6eadf; color: #8b4d25; }
  label { display: grid; gap: 6px; margin: 12px 0; }
  label span { font-size: 12px; color: #6d6760; }
  input {
    box-sizing: border-box;
    width: 100%;
    height: 36px;
    border: 1px solid rgba(0,0,0,.16);
    border-radius: 6px;
    padding: 0 10px;
    font: inherit;
    background: #fff;
  }
  input:focus { outline: 2px solid rgba(198,106,74,.28); border-color: #c66a4a; }
  .secret-row { display: flex; gap: 8px; }
  .secret-row input { flex: 1; min-width: 0; }
  .secret-row button { width: 76px; height: 36px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button {
    height: 34px;
    border: 1px solid rgba(0,0,0,.14);
    border-radius: 6px;
    background: #fff;
    color: #1c1c1c;
    padding: 0 12px;
    cursor: pointer;
    font: inherit;
  }
  button:hover:not(:disabled) { background: #f3efe9; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.primary { background: #1c1c1c; color: #fff; border-color: #1c1c1c; }
  button.primary:hover:not(:disabled) { background: #333; }
  .meta { margin: 10px 0 0; color: #6d6760; font-size: 12px; }
`;
document.head.appendChild(style);

render(<App />, document.getElementById("root")!);
