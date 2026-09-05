"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { ServiceSurvey } from "./service-survey";
import { visibleSurveyCandidates } from "../../lib/service-survey";
import {
  api,
  dateTime,
  money,
  running,
  shortId,
  type Purchase,
  type Task,
} from "../../lib/core-api";
import {
  Badge,
  ErrorMessage,
  Events,
  Field,
  Notice,
  PageHeading,
  useResource,
} from "./shared";

const tabs = [
  { key: "request", label: "申請內容" },
  { key: "decision", label: "供應商與政策" },
  { key: "records", label: "付款與對帳" },
  { key: "activity", label: "活動紀錄" },
];

export function TaskDetail({
  taskId,
  frozen,
}: {
  taskId: string;
  frozen: boolean;
}) {
  const search = useSearchParams();
  const [tab, setTab] = useState(
    search.get("tab") === "records" ? "records" : "request",
  );
  const resource = useResource<Task>(`/tasks/${taskId}`, true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pending = useRef(false);
  const task = resource.data;
  const actionBusy =
    busy || resource.awaitingAction || running(task?.status ?? "");
  async function action(path: string, body?: unknown) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      if (task) resource.refreshAfterAction(task.updatedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("操作未完成"));
    } finally {
      resource.refresh();
      pending.current = false;
      setBusy(false);
    }
  }
  if (!task)
    return (
      <>
        <PageHeading title="採購案件" description="查閱申請、決策與相關憑證。">
          <Link href="/app" className="workspace-button">
            返回清單
          </Link>
        </PageHeading>
        <ErrorMessage error={resource.error} autoRefresh />
        {resource.loading && <Notice title="正在讀取案件…" />}
      </>
    );
  const selectionSubmitted = !!task.control?.selectedService;
  const candidates = visibleSurveyCandidates(task.candidates ?? [], task.control?.requirements);
  const step = task.purchase || selectionSubmitted ? 3 : task.status === "WAITING_SELECTION" ? 2 : task.status === "CREATED" ? 0 : 1;
  return (
    <>
      <Link href="/app" className="back-link">
        ← 採購申請
      </Link>
      <PageHeading
        title={
          task.intent?.targetCompanyName
            ? `${task.intent.targetCompanyName} · 信用風險報告`
            : "企業信用風險報告採購"
        }
        description={`案件 ${shortId(taskId)}　／　建立於 ${dateTime(task.createdAt)}`}
      >
        <Badge status={task.status} />
        {task.status === "CREATED" && (
          <button
            className="workspace-button primary"
            disabled={actionBusy || (selectionSubmitted && frozen)}
            onClick={() => void action(`/tasks/${taskId}/${selectionSubmitted ? "run" : "discover"}`)}
          >
            {actionBusy ? "處理中…" : selectionSubmitted ? "繼續採購處理" : "開始探索"}
          </button>
        )}
      </PageHeading>
      <ol className="procurement-steps" aria-label="採購流程">
        {["建立申請", "Agent 探索服務", "人工選用服務", "採購與付款"].map((label, index) => (
          <li key={label} className={index <= step ? "is-active" : undefined} aria-current={index === step ? "step" : undefined}>
            <span>{index + 1}</span>{label}
          </li>
        ))}
      </ol>
      <ErrorMessage error={error || resource.error} autoRefresh={!error} />
      {task.status === "WAITING_SELECTION" && (
        <ServiceSurvey key={task.updatedAt} task={task} busy={actionBusy} frozen={frozen}
          onSelect={(selection) => void action(`/tasks/${taskId}/select`, selection)}
          onExplore={() => void action(`/tasks/${taskId}/discover`)} />
      )}
      {task.status === "FAILED" && !task.purchase && (
        <button className="workspace-button" disabled={actionBusy} onClick={() => void action(`/tasks/${taskId}/discover`)}>重新探索服務</button>
      )}
      {task.status === "ACTION_REQUIRED" &&
        task.error?.code === "APPROVAL_REQUIRED" &&
        task.control?.pendingTerms && (
          <section className="workspace-panel" aria-labelledby="approval-title">
            <div className="panel-heading">
              <h2 id="approval-title">確認付款報價</h2>
              <Badge status="ACTION_REQUIRED" />
            </div>
            <div className="control-content">
              <p>
                報價超過人工核准門檻 {money(task.control.approvalLimitAtomic)}{" "}
                USDC，目前尚未建立付款。核准只適用本次完整條款；報價變更會重新檢查。
              </p>
              <dl className="policy-fields">
                <Field label="供應商服務" mono>
                  {task.control.pendingTerms.serviceId}
                </Field>
                <Field label="待核准金額">
                  {money(task.control.pendingTerms.amountAtomic)} USDC
                </Field>
                <Field label="收款地址" mono>
                  {task.control.pendingTerms.payTo}
                </Field>
                <Field label="付款網路" mono>
                  {task.control.pendingTerms.network}
                </Field>
                <Field label="代幣合約" mono>
                  {task.control.pendingTerms.token}
                </Field>
              </dl>
              <button
                className="workspace-button primary"
                disabled={actionBusy || frozen}
                onClick={() => void action(`/tasks/${taskId}/approve`)}
              >
                {actionBusy ? "等待處理…" : "核准此報價並繼續"}
              </button>
            </div>
          </section>
        )}
      {task.error && (
        <div className="case-alert" role="status">
          <strong>
            {task.status === "REJECTED"
              ? "此申請未通過採購評估"
              : "此案件需要確認"}
          </strong>
          <p>{task.error.message}</p>
          <small className="record-id">{task.error.code}</small>
          <p>
            {task.purchase?.payment?.status === "SETTLED"
              ? "付款已完成，請查看既有憑證，不要另建案件重複付款。"
              : task.purchase
                ? "請先確認付款與對帳紀錄，再決定後續處理。"
                : "尚未建立採購付款紀錄。"}
          </p>
        </div>
      )}
      {(running(task.status) || resource.awaitingAction) && (
        <div className="processing-note" role="status">
          系統正在處理此案件，狀態將自動更新。你可以離開此頁，稍後從清單繼續查看。
        </div>
      )}
      <section className="case-summary" aria-label="案件摘要">
        <div>
          <span>預算上限</span>
          <strong>
            {task.intent
              ? `${money(task.intent.maxAmount.atomic)} USDC`
              : "待解析"}
          </strong>
        </div>
        <div>
          <span>採購金額</span>
          <strong>
            {task.purchase
              ? `${money(task.purchase.actualAmountAtomic ?? task.purchase.expectedAmountAtomic)} USDC`
              : "—"}
          </strong>
        </div>
        <div>
          <span>成本中心</span>
          <strong>{task.intent?.costCenter ?? "依公司設定"}</strong>
        </div>
        <div>
          <span>最後更新</span>
          <strong>{dateTime(task.updatedAt)}</strong>
        </div>
      </section>
      <section className="workspace-panel case-panel">
        <div className="case-tabs" role="tablist" aria-label="案件資料">
          {tabs.map((item, index) => (
            <button
              key={item.key}
              id={`tab-${item.key}`}
              role="tab"
              aria-selected={tab === item.key}
              aria-controls={`panel-${item.key}`}
              tabIndex={tab === item.key ? 0 : -1}
              onClick={() => setTab(item.key)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (index +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            tabs.length) %
                          tabs.length;
                  setTab(tabs[next].key);
                  document.getElementById(`tab-${tabs[next].key}`)?.focus();
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="case-tab-content"
        >
          {tab === "request" && (
            <>
              <div className="section-heading">
                <h2>原始採購需求</h2>
                <span>建立後留存，不覆蓋原始內容</span>
              </div>
              <p className="request-prompt">{task.prompt}</p>
              <dl className="policy-fields">
                <Field label="完整案件編號" mono>
                  {task.taskId}
                </Field>
                <Field label="服務類型">企業信用風險報告</Field>
                <Field label="發票要求">{(task.control?.requirements?.requiresTwInvoice ?? task.intent?.requiresTwInvoice) ? "需要發票" : "不限制"}</Field>
                <Field label="Mello Registry 認證">{task.control?.requirements?.requiresRegistryCertification ? "需要有效認證" : "不限制"}</Field>
                <Field label="發票統一編號" mono>
                  {task.intent?.buyerBusinessId ?? "探索時由公司設定帶入"}
                </Field>
                <Field label="成本中心">
                  {task.intent?.costCenter ?? "探索時由公司設定帶入"}
                </Field>
              </dl>
              {task.intent?.usedDemoDefaultTarget && (
                <p className="case-alert">
                  企業名稱未成功解析，系統使用預設查詢標的。請先核對報告，不要直接用於業務決策。
                </p>
              )}
              {task.status === "CREATED" && (
                <p className="panel-note">
                  {selectionSubmitted ? "已選用服務，等待付款前檢查。" : "點選「開始探索」，Agent 會先比較服務的報價、發票與認證。由你選用服務後，再送出採購。"}
                </p>
              )}
            </>
          )}
          {tab === "decision" && (
            <>
              <div className="section-heading">
                <h2>供應商評估</h2>
                <span>{candidates.length} 個候選服務</span>
              </div>
              {candidates.length ? (
                <div className="table-scroll">
                  <table className="records-table">
                    <thead>
                      <tr>
                        <th>供應商</th>
                        <th>報價</th>
                        <th>台灣發票</th>
                        <th>Mello Registry 認證</th>
                        <th>評估結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((candidate) => {
                        const selected =
                          task.purchase?.selectedService.id ===
                          (candidate.serviceId ?? candidate.id);
                        return (
                          <tr
                            key={candidate.serviceId ?? candidate.id}
                            className={selected ? "selected-row" : undefined}
                          >
                            <td>
                              <strong>{candidate.displayName ?? candidate.sellerLegalName}</strong>
                              {candidate.displayName && <small>供應商：{candidate.sellerLegalName}</small>}
                              <small>
                                {candidate.serviceId ?? candidate.id}
                              </small>
                              {candidate.discoverySource === "cdp_bazaar" && <small>Bazaar 候選 · {candidate.verificationStatus === "VERIFIED" ? "認證有效" : "認證未通過"}</small>}
                            </td>
                            <td className="nowrap">
                              {money(candidate.priceAtomic)} USDC
                            </td>
                            <td>
                              {candidate.supportsTwInvoice
                                ? "有（Demo 測試）"
                                : "無"}
                            </td>
                            <td>{candidate.verificationStatus === "VERIFIED" ? "有" : "無"}</td>
                            <td>
                              <strong
                                className={
                                  candidate.eligible
                                    ? "positive-text"
                                    : "negative-text"
                                }
                              >
                                {selected
                                  ? "已選用"
                                  : candidate.eligible
                                    ? "符合條件"
                                    : "不符合需求"}
                              </strong>
                              <small>
                                {candidate.humanSummary ??
                                  candidate.reasonCodes?.join("、")}
                              </small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Notice title={task.status === "WAITING_SELECTION" ? "沒有符合條件的服務" : "尚無供應商評估"}>
                  {task.status === "WAITING_SELECTION" ? "可重新探索，或建立另一筆申請調整服務條件。" : "開始探索後，這裡會保存候選報價、發票及認證能力。"}
                </Notice>
              )}
              {task.decisionSummary && (
                <p className="decision-summary">{task.decisionSummary}</p>
              )}
              <div className="section-heading">
                <h2>採購政策紀錄</h2>
                {task.purchase?.policyDecision && (
                  <span
                    className={
                      task.purchase.policyDecision.approved
                        ? "positive-text"
                        : "negative-text"
                    }
                  >
                    {task.purchase.policyDecision.approved
                      ? "已核准"
                      : "未核准"}
                  </span>
                )}
              </div>
              {task.purchase?.policySnapshot ? (
                <dl className="policy-fields">
                  <Field label="政策版本">
                    {task.purchase.policySnapshot.version}
                  </Field>
                  <Field label="單筆金額上限">
                    {money(task.purchase.policySnapshot.perTxLimitAtomic)} USDC
                  </Field>
                  <Field label="發票要求">
                    {task.purchase.policySnapshot.requireTwInvoice
                      ? "必須支援台灣發票"
                      : "依採購需求"}
                  </Field>
                  <Field label="政策識別碼" mono>
                    {task.purchase.policyHash}
                  </Field>
                </dl>
              ) : (
                <p className="panel-note">
                  {task.status === "REJECTED"
                    ? "本案件未建立採購授權；拒絕依據請見評估結果與活動紀錄。"
                    : "尚無已保存的政策快照。"}
                </p>
              )}
            </>
          )}
          {tab === "records" &&
            (task.purchase ? (
              <PurchaseRecords
                purchase={task.purchase}
                busy={actionBusy}
                action={action}
              />
            ) : (
              <Notice title="尚無付款或憑證">
                {task.status === "REJECTED"
                  ? "此申請未通過評估，未建立採購付款紀錄。"
                  : "採購通過評估後，付款、交付與發票紀錄會集中在這裡。"}
              </Notice>
            ))}
          {tab === "activity" && <Events events={task.timeline} />}
        </div>
      </section>
    </>
  );
}

function PurchaseRecords({
  purchase,
  busy,
  action,
}: {
  purchase: Purchase;
  busy: boolean;
  action: (path: string) => Promise<void>;
}) {
  return (
    <>
      <div className="reconciliation-heading">
        <div>
          <h2>三方對帳</h2>
          <p>付款、服務與發票各自核對，保留原始紀錄。</p>
        </div>
        <Badge status={purchase.reconciliation?.status} />
      </div>
      <div className="evidence-columns">
        <section>
          <div className="evidence-title">
            <h3>付款</h3>
            <Badge status={purchase.payment?.status} />
          </div>
          <dl>
            <Field label="結算金額">
              {money(purchase.actualAmountAtomic)} USDC
            </Field>
            <Field label="付款識別碼" mono>
              {purchase.paymentAuthorization?.paymentId}
            </Field>
            <Field label="交易識別碼" mono>
              <Transaction
                hash={purchase.payment?.transactionHash}
                explorer={purchase.explorerLinks?.payment}
              />
            </Field>
            <Field label="結算模式">
              {purchase.modes?.payment === "mock"
                ? "模擬結算 · 無實際鏈上付款"
                : purchase.modes?.payment}
            </Field>
          </dl>
        </section>
        <section>
          <div className="evidence-title">
            <h3>服務交付</h3>
            <Badge status={purchase.delivery?.status} />
          </div>
          <dl>
            <Field label="供應商">
              {purchase.selectedService.displayName ?? purchase.selectedService.sellerLegalName}
            </Field>
            <Field label="採購服務" mono>
              {purchase.selectedService.id}
            </Field>
            <Field label="服務發現來源">
              {purchase.discoveryEvidence?.source === "cdp_bazaar" ? "CDP Bazaar" : purchase.discoveryEvidence?.source === "local_registry" ? "Mello Registry 本地目錄" : "本地 Demo／歷史案件"}
            </Field>
            {purchase.discoveryEvidence && <>
              <Field label="本次認證要求">{purchase.discoveryEvidence.requiresCertification === false ? "不限制" : "需要有效認證"}</Field>
              <Field label="當時認證版本">{purchase.discoveryEvidence.verificationRevision ?? "無認證紀錄"}</Field>
              <Field label="服務探索時間">{dateTime(purchase.discoveryEvidence.fetchedAt)}</Field>
            </>}
            <Field label="服務報價">
              {money(purchase.expectedAmountAtomic)} USDC
            </Field>
          </dl>
          {purchase.delivery?.status === "DELIVERED" &&
            purchase.delivery.responseBody != null && (
              <details className="report-content">
                <summary>查看交付報告</summary>
                <pre>
                  {JSON.stringify(purchase.delivery.responseBody, null, 2)}
                </pre>
              </details>
            )}
          <p className="sandbox-note">
            目前信用報告為 Demo
            資料，非正式徵信評等。鏈上紀錄僅驗證留存雜湊，不證明報告內容真實。
          </p>
        </section>
        <section>
          <div className="evidence-title">
            <h3>發票</h3>
            <Badge status={purchase.invoice?.status} />
          </div>
          <dl>
            <Field label="發票號碼" mono>
              {purchase.invoice?.invoiceNumber}
            </Field>
            <Field label="介接模式">{purchase.modes?.invoice}</Field>
            {purchase.invoice?.buyerProfile && <>
              <Field label="發票抬頭">{purchase.invoice.buyerProfile.legalName}</Field>
              <Field label="發票統一編號" mono>{purchase.invoice.buyerProfile.businessId}</Field>
              <Field label="發票收件 Email">{purchase.invoice.buyerProfile.email}</Field>
              <Field label="發票地址">{purchase.invoice.buyerProfile.address || "—"}</Field>
            </>}
          </dl>
          <p className="sandbox-note">
            SANDBOX / TEST INVOICE
            <br />
            僅供測試，不具正式發票效力。
          </p>
          {purchase.invoice?.lastError && (
            <p className="negative-text">{purchase.invoice.lastError}</p>
          )}
          {purchase.availableActions?.retryInvoice && (
            <button
              className="workspace-button"
              disabled={busy}
              onClick={() =>
                void action(`/purchases/${purchase.purchaseId}/retry-invoice`)
              }
            >
              重試取得發票
            </button>
          )}
        </section>
      </div>
      <details className="technical-records">
        <summary>授權與歸檔資料</summary>
        <dl className="policy-fields">
          <Field label="採購識別碼" mono>
            {purchase.purchaseId}
          </Field>
          <Field label="授權雜湊" mono>
            {purchase.paymentAuthorizationHash}
          </Field>
          <Field label="收款地址" mono>
            {purchase.payToAddress}
          </Field>
          <Field label="網路" mono>
            {purchase.network}
          </Field>
        </dl>
        {purchase.anchors?.map((anchor) => (
          <div className="anchor-row" key={anchor.kind}>
            <span>{anchor.kind}</span>
            <Badge status={anchor.status} />
            <span className="record-id">
              <Transaction
                hash={anchor.transactionHash}
                explorer={purchase.explorerLinks?.anchor}
              />
            </span>
          </div>
        ))}
        <p className="panel-note">歸檔模式：{purchase.modes?.anchor ?? "—"}</p>
        {purchase.availableActions?.retryAnchor && (
          <button
            className="workspace-button"
            disabled={busy}
            onClick={() =>
              void action(`/purchases/${purchase.purchaseId}/retry-anchor`)
            }
          >
            重試歸檔
          </button>
        )}
      </details>
      {purchase.availableActions?.reconcilePayment && (
        <div className="case-alert">
          <p>付款結果尚待確認。此操作只核對已有交易，不重新付款。</p>
          <button
            className="workspace-button"
            disabled={busy}
            onClick={() =>
              void action(`/purchases/${purchase.purchaseId}/reconcile-payment`)
            }
          >
            核對既有付款
          </button>
        </div>
      )}
    </>
  );
}

function Transaction({
  hash,
  explorer,
}: {
  hash?: string | null;
  explorer?: string | null;
}) {
  if (!hash) return <>尚無交易</>;
  let href: string | null = null;
  try {
    if (explorer && /^0x[\da-fA-F]{64}$/.test(hash)) {
      const url = new URL(`${explorer.replace(/\/$/, "")}/tx/${hash}`);
      if (url.protocol === "https:") href = url.href;
    }
  } catch {
    /* Invalid explorer metadata must never hide the actual hash. */
  }
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {hash} ↗
    </a>
  ) : (
    <>{hash}</>
  );
}
