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
      const timer = setTimeout(() => reject(new Error("WebView did not answer")), 2500);
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebView closed")); });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate", params: {
          expression: "({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>b.innerText)})",
          returnByValue: true
        }
      })));
      socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        resolve(message.result?.result?.value);
      });
    });
    if (result?.text.includes("Windows 离线工具版") && result.buttons.some(t => t.includes("公文"))
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
