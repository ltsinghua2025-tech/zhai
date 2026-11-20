import { expect, it } from "vitest";
import { getWebSelectionFiles, openDialog, releaseWebSelection } from "./tauriCompat";

it("cleans up a chooser even if the browser never fired cancel", async () => {
  const pending = openDialog({ multiple: true });
  expect(document.querySelector("input[type=file]")).not.toBeNull();
  window.dispatchEvent(new Event("pointerdown"));
  expect(await pending).toBeNull();
  expect(document.querySelector("input[type=file]")).toBeNull();
});

it("handles native cancel and a subsequent folder selection", async () => {
  const pending = openDialog({ directory: true });
  document.querySelector("input[webkitdirectory]")!.dispatchEvent(new Event("cancel"));
  expect(await pending).toBeNull();
  const next = openDialog({ directory: true });
  const input = document.querySelector("input[webkitdirectory]")!;
  const file = new File(["sample"], "测试.txt");
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
  const token = await next;
  expect(typeof token).toBe("string");
  expect(getWebSelectionFiles(token as string)).toEqual([file]);
  releaseWebSelection(token as string);
  expect(getWebSelectionFiles(token as string)).toEqual([]);
  expect(document.querySelector("input[webkitdirectory]")).toBeNull();
});
