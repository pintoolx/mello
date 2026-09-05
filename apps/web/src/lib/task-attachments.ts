export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;
export const ATTACHMENT_ACCEPT = ".pdf,.docx,.txt,.md";

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

export interface AttachmentMetadata {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export function attachmentMediaType(file: { name: string; size: number }): string {
  const mediaType = MEDIA_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (!mediaType) throw new Error("文件格式須為 PDF、DOCX、TXT 或 MD。");
  if (!file.name.trim() || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/u.test(file.name))
    throw new Error("檔名須為 1 至 180 字，且不可包含路徑或控制字元。");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES)
    throw new Error("每個文件須大於 0 bytes，且不超過 2 MB。");
  return mediaType;
}

export function attachmentSize(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Transport encoding only. No document extraction or Agent processing takes place.
export async function attachmentBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function saveAttachment(attachment: AttachmentMetadata & { contentBase64: string }) {
  const binary = atob(attachment.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== attachment.sizeBytes || bytes.length > MAX_ATTACHMENT_BYTES)
    throw new Error("文件內容不完整，請稍後再下載。");
  // Always download as an attachment; never render user-supplied documents inline.
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
