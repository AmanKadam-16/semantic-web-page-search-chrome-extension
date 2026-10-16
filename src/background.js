// Service worker: injects the find bar on demand and relays requests between
// content scripts and the offscreen document that hosts the model.

const OFFSCREEN_URL = "offscreen.html";
const ports = new Map(); // portKey -> Port

let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run the EmbeddingGemma 2 model with WebGPU/WASM to embed page text.",
    })
    .finally(() => (creating = null));
  await creating;
}

// Toolbar click or Ctrl+Shift+F (the manifest binds it to _execute_action).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    // chrome://, the Web Store and PDFs can't be scripted.
    console.warn("Semantic Ctrl+F can't run here:", err.message);
    await chrome.action.setBadgeBackgroundColor({ color: "#b3261e", tabId: tab.id });
    await chrome.action.setBadgeText({ text: "✕", tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 2000);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sctrlf") return;
  const portKey = crypto.randomUUID();
  ports.set(portKey, port);
  port.onDisconnect.addListener(() => ports.delete(portKey));

  port.onMessage.addListener(async ({ id, type, payload }) => {
    try {
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ target: "offscreen", type, payload, portKey });
      if (!res) throw new Error("Model worker did not respond");
      safePost(port, res.ok ? { id, result: res.result } : { id, error: res.error });
    } catch (err) {
      safePost(port, { id, error: String(err?.message ?? err) });
    }
  });
});

// Progress events from the offscreen document, addressed to one find bar.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "background" || msg.type !== "progress") return;
  const port = ports.get(msg.portKey);
  if (port) safePost(port, { type: "progress", payload: msg.payload });
});

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Tab navigated away mid-request.
  }
}
