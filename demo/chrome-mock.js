// Minimal stand-in for the extension APIs so the real offscreen and content
// scripts can run together on one ordinary web page (demo + smoke test).
const listeners = [];

async function dispatch(msg) {
  for (const fn of listeners) {
    let reply;
    const keepOpen = fn(msg, {}, (r) => (reply = r));
    if (keepOpen === true) {
      return new Promise((resolve) => {
        const poll = () => (reply !== undefined ? resolve(reply) : setTimeout(poll, 5));
        poll();
      });
    }
    if (reply !== undefined) return reply;
  }
}

const ports = new Map();

// chrome.storage.local backed by localStorage, so the demo remembers settings.
const storage = {
  local: {
    async get(key) {
      try {
        const v = localStorage.getItem("sctrlf:" + key);
        return v === null ? {} : { [key]: JSON.parse(v) };
      } catch {
        return {};
      }
    },
    async set(items) {
      try {
        for (const [k, v] of Object.entries(items)) localStorage.setItem("sctrlf:" + k, JSON.stringify(v));
      } catch {}
    },
  },
};

globalThis.chrome = {
  storage,
  runtime: {
    getURL: (p) => new URL(p, location.origin + "/").href,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg.target === "background" && msg.type === "progress") {
        ports.get(msg.portKey)?.emit({ type: "progress", payload: msg.payload });
        return;
      }
      return dispatch(msg);
    },
    connect() {
      const portKey = crypto.randomUUID();
      const handlers = [];
      const port = {
        emit: (m) => handlers.forEach((h) => h(m)),
        onMessage: { addListener: (h) => handlers.push(h) },
        onDisconnect: { addListener() {} },
        async postMessage({ id, type, payload }) {
          const res = await dispatch({ target: "offscreen", type, payload, portKey });
          port.emit(res.ok ? { id, result: res.result } : { id, error: res.error });
        },
      };
      ports.set(portKey, port);
      return port;
    },
  },
};
