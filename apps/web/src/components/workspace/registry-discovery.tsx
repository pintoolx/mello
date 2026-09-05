"use client";

import { useEffect, useRef, useState } from "react";
import { api, dateTime } from "../../lib/core-api";
import { ErrorMessage } from "./shared";

export function verificationLabel(status?: string): string {
  const labels: Record<string, string> = {
    VERIFIED: "人工範圍審核通過", UNREVIEWED: "尚未審核", REVOKED: "認證已撤銷",
    EXPIRED: "認證已到期", BINDING_CHANGED: "服務已變更，需重審",
    INVALID_ENDPOINT: "非公開服務網址", SCOPE_INCOMPLETE: "審核範圍不完整",
  };
  return labels[status ?? "UNREVIEWED"] ?? "尚未確認";
}

interface DiscoveryResult {
  fetchedAt: string;
  partialResults: boolean;
  discoveredResourceCount: number;
  unregisteredResourceCount: number;
  assessments: { serviceId: string; listed: boolean; verification: { status: string }; reasonCodes: string[] }[];
}

export function RegistryDiscovery({ mode }: { mode?: string }) {
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function discover() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    try { setResult(await api<DiscoveryResult>("/registry/discovery", { signal: controller.signal })); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause : new Error("Bazaar 查詢失敗")); }
    finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  return (
    <section className="workspace-panel" aria-busy={busy}>
      <div className="panel-heading">
        <h2>Bazaar 服務發現</h2>
        <button type="button" className="workspace-button" onClick={discover} disabled={busy}>
          {busy ? "查詢中…" : "查詢 Bazaar"}
        </button>
      </div>
      <p className="page-footnote">
        採購來源：{mode === "bazaar" ? "CDP Bazaar，須通過 Mello 認證與企業政策" : "本地 Demo；尚未啟用 Bazaar 採購"}。
        此查詢不付款、不認證商家，也不會變更企業白名單。
      </p>
      {error && <ErrorMessage error={error} />}
      <div aria-live="polite">
        {!result && !error && <p className="page-footnote">{busy ? "正在查詢公共目錄，認證與白名單維持原狀。" : "尚未查詢；按「查詢 Bazaar」檢查目前刊登狀態。"}</p>}
        {result && <>
          <p className="page-footnote">
            查詢時間：{dateTime(result.fetchedAt)}。取得 {result.discoveredResourceCount} 筆服務，其中 {result.unregisteredResourceCount} 筆不符合已登錄服務的完整綁定。
            {result.partialResults ? "結果不完整，僅比較此次回傳的候選；不代表已搜尋全市場。" : ""}
          </p>
          {result.discoveredResourceCount === 0 && <p className="page-footnote">Bazaar 尚未找到符合的服務。請確認公開網址、metadata 與收錄結果，再重新查詢；不會改用本地服務付款。</p>}
          <div className="table-scroll"><table className="records-table">
            <thead><tr><th>登錄服務</th><th>Bazaar 條件比對</th><th>Mello 認證</th></tr></thead>
            <tbody>{result.assessments.map((item) => <tr key={item.serviceId}>
              <td>{item.serviceId}</td><td>{item.listed ? "找到相同服務與報價" : "未找到或條件已變更"}</td>
              <td>{verificationLabel(item.verification.status)}</td>
            </tr>)}</tbody>
          </table></div>
          {result.assessments.length === 0 && <p className="page-footnote">Mello 尚無可供比對的登錄服務，請由管理員建立服務與審核紀錄。</p>}
        </>}
      </div>
    </section>
  );
}
