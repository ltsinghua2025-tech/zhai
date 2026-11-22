import { setTimeout as wait } from "node:timers/promises";

// Inspect the freshly installed application's own WebView on the CI loopback port.
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid test port");
const deadline = Date.now() + 60000;
let last = "Window did not open";
while (Date.now() < deadline) {
  let socket;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const pages = await response.json();
    const page = pages.find(p => p.type === "page" && /^https?:\/\/tauri\.localhost(?:\/|$)/.test(p.url));
    if (!page) throw new Error("Installed application page did not load");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebView did not answer")), 5000);
      const send = (id, method, params = {}) => socket.send(JSON.stringify({ id, method, params }));
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebView closed")); });
      socket.addEventListener("open", () => send(1, "Network.enable"));
      socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.error) {
          clearTimeout(timer);
          reject(new Error(message.error.message));
        } else if (message.id === 1) {
          send(2, "Network.emulateNetworkConditions", {
            offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
          });
        } else if (message.id === 2) {
          send(3, "Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `
            (async () => {
              const buttons = [...document.querySelectorAll('button')];
              const names = buttons.map(b => b.innerText);
              const word = buttons.find(b => b.innerText.includes('现有 Word 一键公文排版'));
              word?.click();
              await new Promise(done => setTimeout(done, 350));
              return { text: document.body.innerText, buttons: names, offline: !navigator.onLine,
                       canChooseFile: [...document.querySelectorAll('button')].some(b => b.innerText.includes('添加文件')) };
            })()` });
        } else if (message.id === 3) {
          clearTimeout(timer);
          resolve(message.result?.result?.value);
        }
      });
    });
    if (result?.offline && result.canChooseFile && result.text.includes("Windows 离线工具版") && result.buttons.some(t => t.includes("公文"))
        && result.buttons.some(t => t.includes("合并"))
        && !result.buttons.some(t => /模型服务|文件 Agent/.test(t))) {
      console.log("Installed WebView rendered the offline edition and its local document tools.");
      process.exit(0);
    }
    last = (result?.text || "Empty offline page").slice(0, 240);
  } catch (error) {
    last = String(error);
  } finally {
    socket?.close();
  }
  await wait(350);
}
throw new Error("Installed offline GUI check failed: " + last);
