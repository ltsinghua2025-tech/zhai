import { afterEach, expect, it, vi } from "vitest";
import { openDialog, releaseWebSelection } from "./tauriCompat";
import { uploadWebSelection, webRunSkill, webTestSkill } from "./webApi";
import { webTurnMaterials } from "./turnMaterials";
import type { AgentAttachment, AgentMessage } from "../types";

async function choose(files: File[]) {
  const pending = openDialog({multiple: true});
  const input = document.querySelector("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files });
  input.dispatchEvent(new Event("change"));
  return (await pending) as string;
}

afterEach(() => vi.unstubAllGlobals());

it("sends each File as a separate upload and reuses test references when running", async () => {
  const files = [new File(["one"], "甲.xlsx"), new File(["two"], "乙.xlsx")];
  const token = await choose(files);
  const refs = [{uploadId: "a"}, {uploadId: "b"}];
  const uploaded: BodyInit[] = [];
  const executes: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("/uploads?")) {
      expect(init.headers).toMatchObject({"Content-Type": "application/octet-stream"});
      uploaded.push(init.body!);
      return Response.json(refs[uploaded.length - 1]);
    }
    executes.push(JSON.parse(String(init.body)).files);
    return Response.json(url.endsWith("/test") ? {testStatus: "passed"} : {artifacts: [], outputDirectory: "output"});
  }));
  await webTestSkill("book", [token, "web-attachment:previous"], {});
  await webRunSkill({runId: "rerun", skillId: "book", paths: [token, "web-attachment:previous"], parameters: {}});
  expect(uploaded).toEqual(files);
  expect(executes).toEqual([ [...refs, {attachmentId:"previous"}], [...refs, {attachmentId:"previous"}] ]);
  releaseWebSelection(token);
});

it("retains the session and folder-relative filename on chat upload", async () => {
  const file = new File(["example"], "旧 表.xlsx");
  Object.defineProperty(file, "webkitRelativePath", {value:"材料/明细/旧 表.xlsx"});
  const token = await choose([file]);
  const fake = vi.fn(async (url: string, init: RequestInit) => {
    const query = new URL(url, "http://localhost").searchParams;
    expect(query.get("sessionId")).toBe("s");
    expect(query.get("relativePath")).toBe("材料/明细/旧 表.xlsx");
    expect(query.get("groupName")).toBe("材料");
    expect(init.body).toBe(file);
    return Response.json({id:"1"});
  });
  vi.stubGlobal("fetch", fake);
  expect(await uploadWebSelection("s", {kind:"folder", path:token})).toEqual([{id:"1"}]);
  releaseWebSelection(token);
});

it("uses newly added inputs, carries the previous selection for follow-ups and honors explicit empty selection", () => {
  const first = {id:"a", createdAt:"2026-11-20T00:00:00Z"} as AgentAttachment;
  const second = {id:"b", createdAt:"2026-11-20T00:01:00Z"} as AgentAttachment;
  const turns = [{id:"first", role:"user", attachmentIds:["a"], createdAt:"2026-11-20T00:00:30Z"} as AgentMessage];
  expect(webTurnMaterials([first], turns).ids).toEqual(["a"]);
  expect(webTurnMaterials([first, second], turns).ids).toEqual(["b"]);
  expect(webTurnMaterials([first, second], turns, ["a","b"]).ids).toEqual(["a","b"]);
  expect(webTurnMaterials([first, second], turns, []).ids).toEqual([]);
  expect(webTurnMaterials([], turns).ids).toEqual([]);
  expect(webTurnMaterials([first], [{ ...turns[0], attachmentIds: undefined }]).ids).toEqual([]);
});
