import { Channel, invoke as invokeV2 } from "@tauri-apps/api/core";
import { listen as listenV2, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openV2 } from "@tauri-apps/plugin-dialog";
import { invoke as invokeV1 } from "@tauri-apps/api-v1/tauri";
import { listen as listenV1 } from "@tauri-apps/api-v1/event";
import { open as openV1 } from "@tauri-apps/api-v1/dialog";
import { appWindow } from "@tauri-apps/api-v1/window";

export const isKylinLegacy = import.meta.env.VITE_KYLIN_LEGACY === "1";

const webSelections = new Map<string, File[]>();

export function randomId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function hasTauriRuntime() {
  return "__TAURI_INTERNALS__" in window || "__TAURI_IPC__" in window;
}

export function isWebRuntime() {
  return !hasTauriRuntime();
}

export function getWebSelectionFiles(token: string) {
  return webSelections.get(token) || [];
}

export function invokeCompat<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return isKylinLegacy ? invokeV1<T>(command, args) : invokeV2<T>(command, args);
}

export function listenCompat<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (isKylinLegacy)
    return listenV1<T>(event, (message) => handler(message.payload));
  return listenV2<T>(event, (message) => handler(message.payload));
}

export async function invokeWithEvents<TEvent, TResult>(
  command: string,
  args: Record<string, unknown>,
  onEvent: (event: TEvent) => void,
): Promise<TResult> {
  if (!isKylinLegacy) {
    const channel = new Channel<TEvent>();
    channel.onmessage = onEvent;
    return invokeV2<TResult>(command, { ...args, onEvent: channel });
  }
  const eventName = `zhai-${command}-${randomId()}`;
  const unlisten = await listenV1<TEvent>(eventName, (message) => onEvent(message.payload));
  try {
    return await invokeV1<TResult>(command, { ...args, eventName });
  } finally {
    unlisten();
  }
}

export function openDialog(options: Parameters<typeof openV2>[0]): Promise<string | string[] | null> {
  if (isWebRuntime()) {
    const webOptions = options || {};
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = Boolean(webOptions.multiple);
      if (webOptions.directory) {
        input.multiple = true;
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
      }
      const accept = webOptions.filters
        ?.flatMap((filter) => filter.extensions || [])
        .map((extension) => `.${extension}`)
        .join(",");
      if (accept) input.accept = accept;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        if (!files.length) return resolve(null);
        const token = `web-selection:${randomId()}`;
        webSelections.set(token, files);
        resolve(token);
      };
      input.addEventListener("cancel", () => resolve(null), { once: true });
      input.click();
    });
  }
  return isKylinLegacy
    ? openV1(options as Parameters<typeof openV1>[0])
    : openV2(options) as Promise<string | string[] | null>;
}

export async function onFileDrop(handler: (paths: string[]) => void | Promise<void>) {
  if (!isKylinLegacy) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "drop" && event.payload.paths.length)
        await handler(event.payload.paths);
    });
  }
  return appWindow.onFileDropEvent(async (event) => {
    if (event.payload.type === "drop" && event.payload.paths.length)
      await handler(event.payload.paths);
  });
}
