"use client";

import { useRef, useState } from "react";
import { api } from "../../lib/core-api";
import { attachmentSize, saveAttachment, type AttachmentMetadata } from "../../lib/task-attachments";
import { ErrorMessage, useResource } from "./shared";

export function TaskAttachments({ taskId }: { taskId: string }) {
  const resource = useResource<{ attachments: AttachmentMetadata[] }>(`/tasks/${taskId}/attachments`);
  const [error, setError] = useState<Error | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const pending = useRef(false);
  async function download(id: string) {
    if (pending.current) return;
    pending.current = true;
    setDownloading(id);
    setError(null);
    try {
      saveAttachment(await api<AttachmentMetadata & { contentBase64: string }>(`/tasks/${taskId}/attachments/${id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("文件未能下載"));
    } finally {
      pending.current = false;
      setDownloading(null);
    }
  }
  return <section className="case-attachments" aria-labelledby="case-attachments-title">
    <div className="section-heading"><h2 id="case-attachments-title">需求文件</h2><span>隨案件保存</span></div>
    <ErrorMessage error={error || resource.error} autoRefresh={!error} />
    {resource.loading ? <p role="status">正在讀取文件清單…</p> : resource.data && (
      resource.data.attachments.length ? <ul className="attachment-list">
        {resource.data.attachments.map((attachment) => <li key={attachment.id}>
          <span><strong>{attachment.fileName}</strong><small>{attachmentSize(attachment.sizeBytes)} · 已保存</small></span>
          <button type="button" className="workspace-button" disabled={!!downloading} aria-busy={downloading === attachment.id}
            aria-label={`下載 ${attachment.fileName}`} onClick={() => void download(attachment.id)}>
            {downloading === attachment.id ? "下載中…" : "下載"}
          </button>
        </li>)}
      </ul> : <p className="panel-note">此申請未附加文件。</p>
    )}
  </section>;
}
