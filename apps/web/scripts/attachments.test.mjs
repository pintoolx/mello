import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentBase64, attachmentMediaType, attachmentSize, MAX_ATTACHMENT_BYTES } from "../src/lib/task-attachments.ts";
import { boundedBody, BodyTooLarge } from "../src/lib/bounded-body.ts";

test("documents are bounded and only encoded for storage without extraction", async () => {
  for (const name of ["requirements.pdf", "需求.docx", "說明.txt", "Notes.MD"])
    assert.ok(attachmentMediaType({ name, size: MAX_ATTACHMENT_BYTES }));
  for (const [name, size] of [["test.html", 1], ["test.pdf.exe", 1], ["../test.pdf", 1], ["bad\nname.md", 1], ["empty.txt", 0], ["big.txt", MAX_ATTACHMENT_BYTES + 1]])
    assert.throws(() => attachmentMediaType({ name, size }));
  const content = "總經分析\n需求文件內容";
  assert.equal(await attachmentBase64(new File([content], "需求.txt")), Buffer.from(content).toString("base64"));
  assert.equal(attachmentSize(32), "32 B");
  assert.equal(attachmentSize(1024), "1 KB");
});

test("BFF limits actual bytes even when Content-Length is missing or wrong", async () => {
  const request = (body, headers = {}) => new Request("http://localhost/attachments", { method: "POST", body, headers });
  assert.equal(await boundedBody(request("需求"), 6), "需求");
  await assert.rejects(boundedBody(request("需求"), 5), BodyTooLarge);
  await assert.rejects(boundedBody(request("123456", { "content-length": "1" }), 5), BodyTooLarge);
  await assert.rejects(boundedBody(request("1", { "content-length": "100" }), 5), BodyTooLarge);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedBody(new Request("http://localhost/attachments", { method: "POST", body: stream, duplex: "half" }), 5), BodyTooLarge);
  assert.equal(cancelled, true);
});
