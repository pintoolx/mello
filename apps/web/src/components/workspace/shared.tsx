"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  dateTime,
  statusLabel,
  type AuditEvent,
} from "../../lib/core-api";

export function useResource<T>(path: string, poll = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const awaitingRevision = useRef<{
    updatedAt: string;
    deadline: number;
  } | null>(null);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const refreshAfterAction = useCallback(
    (updatedAt: string) => {
      awaitingRevision.current = { updatedAt, deadline: Date.now() + 30000 };
      refresh();
    },
    [refresh],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchData = async () => {
      try {
        const result = await api<T>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        const status = (result as { status?: string }).status;
        const waiting = awaitingRevision.current;
        const waitingForWorker =
          waiting !== null &&
          (result as { updatedAt?: string }).updatedAt === waiting.updatedAt &&
          Date.now() < waiting.deadline;
        if (!waitingForWorker) awaitingRevision.current = null;
        if (
          poll &&
          (waitingForWorker ||
            !["COMPLETED", "REJECTED", "ACTION_REQUIRED", "FAILED"].includes(
              status ?? "",
            ))
        )
          timer = setTimeout(fetchData, 1200);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error("讀取失敗"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void fetchData();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, version, poll]);
  return { data, error, loading, refresh, refreshAfterAction };
}

export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function Badge({ status }: { status?: string | null }) {
  const tone = [
    "COMPLETED",
    "SETTLED",
    "DELIVERED",
    "MATCHED",
    "CONFIRMED",
  ].includes(status ?? "")
    ? "success"
    : ["FAILED", "REJECTED", "MISMATCH", "FAILED_FINAL"].includes(status ?? "")
      ? "danger"
      : [
            "ACTION_REQUIRED",
            "FAILED_RETRYABLE",
            "ISSUED_DEMO",
            "ISSUED_STAGE",
          ].includes(status ?? "")
        ? "warning"
        : "neutral";
  return (
    <span className={`status-badge ${tone}`}>
      <span aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
export function Notice({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="workspace-notice">
      <h2>{title}</h2>
      {children && <div>{children}</div>}
    </div>
  );
}
export function ErrorMessage({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error-message" role="alert">
      <strong>暫時無法完成操作</strong>
      <p>{error.message}</p>
      {error instanceof ApiError && error.requestId && (
        <small className="record-id">查詢識別碼：{error.requestId}</small>
      )}
      {retry && (
        <button className="workspace-button" onClick={retry}>
          重新讀取
        </button>
      )}
    </div>
  );
}
export function Pagination({
  total,
  offset,
  setOffset,
}: {
  total: number;
  offset: number;
  setOffset: (offset: number) => void;
}) {
  return (
    <div className="table-pagination">
      <span>
        {total ? `${offset + 1}–${Math.min(offset + 20, total)} 筆` : "0 筆"} ／
        共 {total} 筆
      </span>
      <div>
        <button
          className="workspace-button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一頁
        </button>
        <button
          className="workspace-button"
          disabled={offset + 20 >= total}
          onClick={() => setOffset(offset + 20)}
        >
          下一頁
        </button>
      </div>
    </div>
  );
}
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="record-field">
      <dt>{label}</dt>
      <dd className={mono ? "record-id" : undefined}>{children ?? "—"}</dd>
    </div>
  );
}
const eventLabels: Record<string, string> = {
  WORKFLOW_JOB_ENQUEUED: "處理工作已排入佇列",
  TASK_RUN_STARTED: "開始處理採購申請",
  SERVICE_CANDIDATES_EVALUATED: "供應商評估已完成",
  PURCHASE_CREATED_PENDING_LIVE_TERMS: "採購已建立，等待交易條件核對",
  AUTHORIZATION_CREATED: "付款授權已建立",
  AUTHORIZATION_SIMULATED: "付款授權已模擬驗證",
  AUTHORIZE_ANCHOR_ATTEMPT_STARTED: "開始保存授權紀錄",
  AUTHORIZE_ANCHOR_SUBMITTED: "授權紀錄已送出",
  AUTHORIZATION_ANCHOR_CONFIRMED: "授權紀錄已確認",
  PAYMENT_SUBMISSION_INTENT_RECORDED: "付款送出意圖已留存",
  PAID_REQUEST_RELEASE_AUTHORIZED: "付費請求已獲授權",
  SUBMITTED_TO_SELLER: "請求已送至供應商",
  SIGNED_PAID_REQUEST_RELEASED: "已釋出簽署的付費請求",
  PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED: "付款結算與服務交付已確認",
  INVOICING_STARTED: "開始取得發票",
  RECONCILIATION_STARTED: "開始三方對帳",
  FINALIZE_ANCHOR_ATTEMPT_STARTED: "開始保存完成紀錄",
  FINALIZE_ANCHOR_SUBMITTED: "完成紀錄已送出",
  FINALIZE_ANCHOR_CONFIRMED: "完成紀錄已確認",
  TASK_CREATED: "採購申請已建立",
  INTENT_PARSED: "採購需求已解析",
  SERVICES_DISCOVERED: "已取得供應商報價",
  POLICY_APPROVED: "採購政策已核准",
  POLICY_REJECTED: "採購政策未通過",
  PAYMENT_SETTLED: "付款已結算",
  INVOICE_ISSUED: "已取得發票",
  RECONCILIATION_MATCHED: "三方對帳完成",
  TASK_COMPLETED: "案件已完成",
};
export function Events({ events }: { events: AuditEvent[] }) {
  if (!events.length)
    return (
      <Notice title="尚無稽核紀錄">操作發生後，相關事件會保存在這裡。</Notice>
    );
  return (
    <ol className="audit-events">
      {events.map((event) => (
        <li key={event.id}>
          <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
          <div>
            <strong>{eventLabels[event.eventType] ?? event.eventType}</strong>
            <small>
              事件序號 {event.sequence} · {event.eventType}
            </small>
            {event.payload != null && (
              <details>
                <summary>查看紀錄內容</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
