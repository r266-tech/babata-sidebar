import { WebSocket } from "ws";

export async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out: ${url}`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function connectCdp(url, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    let failure;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      clearTimeout(connectTimer);
      reject(error);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
      pending.clear();
      socket.terminate();
    };
    const connectTimer = setTimeout(() => fail(new Error("CDP connection timed out")), timeoutMs);
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new Error("CDP target disconnected")));
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { fail(new Error("CDP returned invalid JSON")); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { fail(new Error("CDP returned an invalid message")); return; }
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
      else call.resolve(message.result);
    });
    socket.once("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          if (failure || socket.readyState !== WebSocket.OPEN) return Promise.reject(failure || new Error("CDP target is not open"));
          return new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`CDP command timed out: ${method}`));
            }, timeoutMs);
            pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
            socket.send(JSON.stringify({ id, method, params }), (error) => { if (error) fail(error); });
          });
        },
        close() { fail(new Error("CDP client closed")); },
      });
    });
  });
}

export async function evaluateCdp(target, expression, awaitPromise = false) {
  const client = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.text || "JavaScript exception"}`);
    return result;
  } finally {
    client.close();
  }
}
