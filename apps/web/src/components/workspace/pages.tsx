"use client";

import Link from "next/link";
import { buildServicePrompt, serviceName, supplierName } from "../../lib/service-catalog";
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, attachmentBase64, attachmentMediaType, attachmentSize, type AttachmentMetadata } from "../../lib/task-attachments";
import { useRouter } from "next/navigation";
import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  atomicAmount,
  PENDING_REQUEST_KEY,
  readPendingRequest,
  type TaskInput,
} from "../../lib/task-input";
import {
  api,
  ApiError,
  dateTime,
  money,
  running,
  shortId,
  type AuditEvent,
  type Control,
  type PageResult,
  type Purchase,
  type Settings,
  type TaskRow,
} from "../../lib/core-api";
import {
  Badge,
  ErrorMessage,
  Events,
  Field,
  Notice,
  PageHeading,
  Pagination,
  useResource,
} from "./shared";

export function RequestList() {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const resource = useResource<PageResult<TaskRow>>(
    `/tasks?limit=20&offset=${offset}`,
  );
  const rows = resource.data?.items ?? [];
  const visible = rows.filter(
    (row) =>
      `${row.prompt} ${row.taskId}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "processing"
          ? running(row.status)
          : row.status === filter)),
  );
  return (
    <>
      <PageHeading
        title="採購申請"
        description="管理採購需求，追蹤處理狀態與相關憑證。"
      >
        <Link href="/app/tasks/new" className="workspace-button primary">
          ＋ 新增採購申請
        </Link>
      </PageHeading>
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>申請清單</h2>
        </div>
        <div className="list-toolbar">
          <label className="search-field">
            <span>搜尋本頁</span>
            <input
              type="search"
              placeholder="需求關鍵字或案件編號"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="status-filter">
            <span>案件狀態</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">全部狀態</option>
              <option value="CREATED">已受理</option>
              <option value="WAITING_SELECTION">待選擇服務</option>
              <option value="processing">處理中</option>
              <option value="COMPLETED">已完成</option>
              <option value="ACTION_REQUIRED">待處理</option>
              <option value="REJECTED">未核准</option>
              <option value="FAILED">處理失敗</option>
            </select>
          </label>
        </div>
        <ErrorMessage error={resource.error} autoRefresh />
        {resource.loading ? (
          <Notice title="正在讀取採購申請…" />
        ) : !resource.error && !visible.length ? (
          <Notice title={rows.length ? "找不到符合條件的申請" : "尚無採購申請"}>
            {rows.length ? (
              "請調整搜尋字詞或案件狀態。"
            ) : (
              <>
                從一筆採購需求開始。供應商決策、付款與憑證會保存在同一個案件。
                <p>
                  <Link href="/app/tasks/new" className="workspace-button">
                    新增第一筆申請
                  </Link>
                </p>
              </>
            )}
          </Notice>
        ) : (
          <div className="table-scroll">
            <table className="records-table">
              <thead>
                <tr>
                  <th>案件／採購需求</th>
                  <th>狀態</th>
                  <th>建立時間</th>
                  <th>最後更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.taskId}>
                    <td className="request-cell">
                      <Link href={`/app/tasks/${row.taskId}`}>
                        <span className="record-id">{shortId(row.taskId)}</span>
                        <strong>{row.prompt}</strong>
                      </Link>
                    </td>
                    <td>
                      <Badge status={row.status} />
                    </td>
                    <td className="nowrap">{dateTime(row.createdAt)}</td>
                    <td className="nowrap">{dateTime(row.updatedAt)}</td>
                    <td>
                      <Link
                        className="text-button nowrap"
                        href={`/app/tasks/${row.taskId}`}
                      >
                        查看案件 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {resource.data && (
          <Pagination
            total={resource.data.total}
            offset={offset}
            setOffset={setOffset}
          />
        )}
      </section>
      <p className="page-footnote">
        申請與處理結果由系統留存。未完成的案件可稍後回到此處繼續查看。
      </p>
    </>
  );
}

const PENDING_CHANGED = "mello:pending-request-changed";
function subscribePending(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(PENDING_CHANGED, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(PENDING_CHANGED, callback);
  };
}
function pendingSnapshot() {
  try {
    return localStorage.getItem(PENDING_REQUEST_KEY) ?? "";
  } catch {
    return "unavailable";
  }
}

export function NewRequest({
  settings,
  frozen,
}: {
  settings: Settings | null;
  frozen: boolean;
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [budget, setBudget] = useState("0.10");
  const [files, setFiles] = useState<{ file: File; clientFileId: string }[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const draftKey = useRef<string | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const uploaded = useRef(new Map<string, AttachmentMetadata>());
  const [requiresTwInvoice, setRequiresTwInvoice] = useState(true);
  const [requiresRegistryCertification, setRequiresRegistryCertification] = useState(true);
  const [approvalLimit, setApprovalLimit] = useState("");
  const [expectedPayTo, setExpectedPayTo] = useState("");
  const snapshot = useSyncExternalStore(
    subscribePending,
    pendingSnapshot,
    () => "loading",
  );
  const stored = useMemo(() => {
    try {
      if (snapshot === "unavailable")
        throw new Error("請允許本站使用瀏覽器儲存空間，再重新載入。");
      return {
        input:
          snapshot === "loading"
            ? null
            : readPendingRequest({ getItem: () => snapshot }),
        error: null,
      };
    } catch (cause) {
      return {
        input: null,
        error: cause instanceof Error ? cause : new Error("待確認申請無法讀取"),
      };
    }
  }, [snapshot]);
  const saved = stored.input;
  const storageReady = snapshot !== "loading" && !stored.error;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const expiredDraft = error instanceof ApiError && error.code === "ATTACHMENT_EXPIRED";
  const submitting = useRef(false);
  function replaceExpiredDraft() {
    if (!saved || !expiredDraft || submitting.current) return;
    try {
      // This exact server error proves the atomic create rolled back. Never
      // discard a request merely because a response timed out or went missing.
      if (readPendingRequest(localStorage)?.requestKey !== saved.requestKey)
        throw new Error("待確認申請已由另一分頁處理，請回採購清單確認。");
      const original = /^採購需求：\n([\s\S]*)\n\n預算上限：(\d+(?:\.\d{1,6})?) USDC。\n/u.exec(saved.prompt);
      if (original) { setDescription(original[1]); setBudget(original[2]); }
      if (saved.requirements) {
        setRequiresTwInvoice(saved.requirements.requiresTwInvoice);
        setRequiresRegistryCertification(saved.requirements.requiresRegistryCertification);
      }
      setApprovalLimit(saved.approvalLimitAtomic ? money(saved.approvalLimitAtomic) : "");
      setExpectedPayTo(saved.expectedPayTo ?? "");
      localStorage.removeItem(PENDING_REQUEST_KEY);
      updateFiles([]);
      setError(null);
      window.dispatchEvent(new Event(PENDING_CHANGED));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("原申請無法確認，請先回採購清單核對。"));
    }
  }
  function updateFiles(next: typeof files) {
    setFiles(next);
    setFileError(null);
    // No task has been sent at this stage. Changing files starts a new upload draft.
    draftKey.current = null;
    uploaded.current.clear();
  }
  function addFiles(selected: FileList | null) {
    if (!selected) return;
    try {
      if (files.length + selected.length > MAX_ATTACHMENTS) throw new Error("最多附加 3 個文件，請先移除不需要的文件。");
      const additions = Array.from(selected).map((file) => {
        attachmentMediaType(file);
        return { file, clientFileId: crypto.randomUUID() };
      });
      updateFiles([...files, ...additions]);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : "文件無法加入");
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!description.trim()) {
      setDescriptionError("請先用文字說明想找的服務，文件可另外附加。");
      document.getElementById("requirements-description")?.focus();
      return;
    }
    setDescriptionError(null);
    await create();
  }
  async function create(recover = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setProgress(recover ? "找回中…" : "建立中…");
    try {
      const previous = readPendingRequest(localStorage);
      if (previous && !recover) {
        throw new Error(
          "前一筆申請尚未確認，請先找回原案件；不會另建第二筆付款。",
        );
      }
      if (recover && !previous)
        throw new Error("待確認申請已由另一分頁處理，請回採購清單確認。");
      const budgetAtomic = previous ? null : atomicAmount(budget);
      if (
        budgetAtomic !== null &&
        (BigInt(budgetAtomic) <= 0 ||
          BigInt(budgetAtomic) > BigInt("1000000000000"))
      )
        throw new Error("預算須介於 0.000001 與 1000000 USDC 之間。");
      const approvalLimitAtomic = previous || !approvalLimit ? null : atomicAmount(approvalLimit);
      if (approvalLimitAtomic !== null && BigInt(approvalLimitAtomic) > BigInt("1000000000000"))
        throw new Error("人工核准門檻不可超過 1000000 USDC。");
      const prompt =
        previous?.prompt ??
        buildServicePrompt({ description, budgetDisplay: money(budgetAtomic), requiresTwInvoice, requiresRegistryCertification });
      const requestKey = previous?.requestKey ?? (draftKey.current ??= crypto.randomUUID());
      const attachmentIds: string[] = [];
      if (!previous) for (const [index, entry] of files.entries()) {
        setProgress(`保存文件 ${index + 1}／${files.length}…`);
        let attachment = uploaded.current.get(entry.clientFileId);
        if (!attachment) {
          attachment = await api<AttachmentMetadata>("/attachments", {
            method: "POST",
            body: JSON.stringify({ requestKey, clientFileId: entry.clientFileId,
              fileName: entry.file.name, mediaType: attachmentMediaType(entry.file),
              sizeBytes: entry.file.size, contentBase64: await attachmentBase64(entry.file) }),
          });
          uploaded.current.set(entry.clientFileId, attachment);
        }
        attachmentIds.push(attachment.id);
      }
      const input: TaskInput = previous ?? {
        prompt,
        requestKey,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        requirements: { requiresTwInvoice, requiresRegistryCertification },
        ...(approvalLimitAtomic !== null
          ? { approvalLimitAtomic }
          : {}),
        ...(expectedPayTo.trim()
          ? { expectedPayTo: expectedPayTo.trim() }
          : {}),
      };
      // Persist before sending. A timeout never authorizes a new request key.
      localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify(input));
      window.dispatchEvent(new Event(PENDING_CHANGED));
      setProgress("建立申請並尋找服務…");
      const result = await api<{ taskId: string }>("/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      try {
        if (readPendingRequest(localStorage)?.requestKey === input.requestKey)
          localStorage.removeItem(PENDING_REQUEST_KEY);
        window.dispatchEvent(new Event(PENDING_CHANGED));
      } catch {
        /* The existing task is known; navigate even if storage becomes unavailable. */
      }
      router.push(`/app/tasks/${result.taskId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("申請未能建立"));
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="新增採購申請"
        description="說明需求並附上相關文件，建立後自動尋找服務，再由你選用並送出採購。"
      >
        <Link href="/app" className="workspace-button">
          返回清單
        </Link>
      </PageHeading>
      <ErrorMessage error={error || stored.error} />
      {saved && (
        <div className="case-alert" role="status">
          <strong>有一筆建立結果待確認的申請</strong>
          <p className="pending-request">{saved.prompt}</p>
          <p>沿用原請求識別碼找回案件，不會自動送出採購或重複建立付款。</p>
          <button
            className="workspace-button"
            type="button"
            disabled={busy}
            onClick={() => void create(true)}
          >
            {busy ? "找回中…" : "找回原申請"}
          </button>
          {expiredDraft && <>
            <p>未提交文件已超過保存期限，後端已確認這筆申請未建立。請重新附加文件後送出。</p>
            <button className="workspace-button" type="button" disabled={busy} onClick={replaceExpiredDraft}>重新附檔</button>
          </>}
        </div>
      )}
      <form className="request-form" onSubmit={submit} aria-busy={busy}>
        <section className="workspace-panel">
          <div className="panel-heading">
            <h2>採購需求</h2>
            <span>＊ 必填</span>
          </div>
          <fieldset className="form-fields" disabled={busy || !!saved}>
            <div className="form-field">
              <label htmlFor="requirements-description">
                需求說明 <span>＊</span>
              </label>
              <textarea
                id="requirements-description"
                name="description"
                autoComplete="off"
                rows={5}
                placeholder="例如：我想找總經分析，關注亞洲市場近期利率與通膨，整理主要觀察重點與風險。"
                required
                maxLength={1000}
                value={description}
                onChange={(event) => { setDescription(event.target.value); if (descriptionError) setDescriptionError(null); }}
                aria-invalid={!!descriptionError}
                aria-describedby={descriptionError ? "requirements-hint requirements-error" : "requirements-hint"}
              />
              {descriptionError && <p id="requirements-error" className="negative-text" role="alert">{descriptionError}</p>}
              <small id="requirements-hint">可描述個股分析、總經分析、加密市場資訊或期貨分析的需求，不必指定企業。預算與條件以下方選項為準。</small>
              <div className="request-attachments">
                <label htmlFor="requirement-files">附加需求文件 <span className="optional">選填</span></label>
                <button className="workspace-button" type="button" aria-describedby="attachment-hint"
                  onClick={() => filePicker.current?.click()}>附加文件{files.length ? `（${files.length}／3）` : ""}</button>
                <input id="requirement-files" ref={filePicker} name="attachments" type="file" multiple accept={ATTACHMENT_ACCEPT} hidden
                  aria-describedby={fileError ? "attachment-hint attachment-error" : "attachment-hint"}
                  aria-invalid={!!fileError}
                  onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
                <small id="attachment-hint">PDF、DOCX、TXT、MD，每個最多 2 MB，最多 3 個。文件隨申請保存；請在上方文字中寫明要找的服務。</small>
                {fileError && <p id="attachment-error" className="negative-text" role="alert">{fileError}</p>}
                {!!files.length && <ul className="attachment-list">
                  {files.map((entry) => <li key={entry.clientFileId}>
                    <span><strong>{entry.file.name}</strong><small>{attachmentSize(entry.file.size)} · 待隨申請保存</small></span>
                    <button className="workspace-button" type="button" aria-label={`移除 ${entry.file.name}`}
                      onClick={() => updateFiles(files.filter((item) => item.clientFileId !== entry.clientFileId))}>移除</button>
                  </li>)}
                </ul>}
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="budget">
                預算上限 <span>＊</span>
              </label>
              <div className="amount-input">
                <input
                  id="budget"
                  name="budget"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  pattern="[0-9]+(\.[0-9]{1,6})?"
                  required
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <span>USDC</span>
              </div>
              <small>以實際報價付款，且須符合公司採購政策。</small>
            </div>
            <fieldset className="service-requirements">
              <legend>服務條件</legend>
              <label className="requirement-choice" htmlFor="requires-invoice">
                <input id="requires-invoice" type="checkbox" checked={requiresTwInvoice}
                  onChange={(event) => setRequiresTwInvoice(event.target.checked)} />
                <span><strong>需要發票</strong><small>僅比對可提供發票的服務；本次使用測試發票。</small></span>
              </label>
              <label className="requirement-choice" htmlFor="requires-certification">
                <input id="requires-certification" type="checkbox" checked={requiresRegistryCertification}
                  onChange={(event) => setRequiresRegistryCertification(event.target.checked)} />
                <span><strong>需要 Mello Registry 認證</strong><small>僅探索認證仍有效的服務。</small></span>
              </label>
              <p>未勾選的條件不限制探索結果，各服務仍會標示發票與認證的有無。</p>
              {!requiresTwInvoice && settings?.policy?.requireTwInvoice && <p>公司目前仍要求發票。探索會顯示無發票的服務，付款時仍須符合公司政策。</p>}
            </fieldset>
            <details className="request-options">
              <summary>付款前控制（選填）</summary>
              <div className="form-field">
                <label htmlFor="approval-limit">人工核准門檻（USDC）</label>
                <input
                  id="approval-limit"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  pattern="[0-9]+(\.[0-9]{1,6})?"
                  value={approvalLimit}
                  onChange={(event) => setApprovalLimit(event.target.value)}
                  placeholder="例如：0.03"
                />
                <small>
                  報價超過此門檻時先暫停，確認完整報價後才付款；不會提高預算。
                </small>
              </div>
              <div className="form-field">
                <label htmlFor="expected-pay-to">限定收款地址</label>
                <input
                  id="expected-pay-to"
                  value={expectedPayTo}
                  onChange={(event) => setExpectedPayTo(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  pattern="0x[0-9a-fA-F]{40}"
                  maxLength={42}
                  placeholder="0x…（留空沿用登錄地址）"
                />
                <small>
                  必須與供應商登錄及即時報價一致。不會修改供應商地址。
                </small>
              </div>
            </details>
          </fieldset>
          <div className="form-footer">
            <span role="status">{busy ? progress : "建立後自動尋找服務，不會立即付款。"}</span>
            <button
              type="submit"
              className="workspace-button primary"
              disabled={
                busy ||
                !!saved ||
                !storageReady ||
                frozen ||
                !settings?.company ||
                !settings?.policy ||
                !settings.services.length
              }
            >
              {busy ? "處理中…" : "建立申請"}
            </button>
          </div>
        </section>
        <aside>
          <section className="workspace-panel">
            <div className="panel-heading">
              <h2>費用歸屬</h2>
            </div>
            <dl className="record-fields">
              <Field label="公司抬頭">
                {settings?.company?.legalName ?? "尚未取得公司資料"}
              </Field>
              <Field label="統一編號" mono>
                {settings?.company?.businessId}
              </Field>
              <Field label="成本中心">
                {settings?.company?.defaultCostCenter}
              </Field>
              <Field label="發票要求">{requiresTwInvoice ? "需要發票（測試環境）" : "不限制"}</Field>
              <Field label="Mello Registry 認證">{requiresRegistryCertification ? "需要有效認證" : "不限制"}</Field>
            </dl>
            <p className="panel-note">發票抬頭與成本中心沿用公司設定。</p>
          </section>
          <section className="form-guidance">
            <h2>從需求到採購</h2>
            <p>
              提交需求 → 選擇服務 → 付款與憑證。
            </p>
            <p>Agent 協助比較報價與服務能力，每筆申請由你選用一個服務。付款前仍會檢查公司政策。</p>
            <p>分析內容為示範範例，非即時行情或投資建議；測試發票不具正式憑證效力。</p>
          </section>
        </aside>
      </form>
    </>
  );
}

export function PurchaseList() {
  const [offset, setOffset] = useState(0);
  const resource = useResource<PageResult<Purchase>>(
    `/purchases?limit=20&offset=${offset}`,
  );
  return (
    <>
      <PageHeading
        title="付款與憑證"
        description="每一筆採購的結算、發票與對帳結果並列，核對三者是否一致。"
      />
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>採購紀錄</h2>
          <span>依建立時間排序</span>
        </div>
        <ErrorMessage error={resource.error} autoRefresh />
        {resource.loading ? (
          <Notice title="正在讀取紀錄…" />
        ) : !resource.error && !resource.data?.items.length ? (
          <Notice title="尚無採購紀錄">
            案件通過評估並建立採購後，相關紀錄會出現在這裡。
          </Notice>
        ) : (
          <div className="table-scroll">
            <table className="records-table">
              <thead>
                <tr>
                  <th>採購案件／供應商</th>
                  <th>採購金額</th>
                  <th>付款狀態</th>
                  <th>付款識別碼</th>
                  <th>發票狀態</th>
                  <th>對帳狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {resource.data?.items.map((row) => (
                  <tr key={row.purchaseId}>
                    <td>
                      <Link
                        href={`/app/tasks/${row.taskId}`}
                        className="record-id"
                      >
                        {shortId(row.taskId)}
                      </Link>
                      <strong className="cell-title">
                        {serviceName(row.selectedService)}
                      </strong>
                      <small>供應商：{supplierName(row.selectedService)}</small>
                      <small>{dateTime(row.createdAt)}</small>
                    </td>
                    <td className="nowrap tabular">
                      {money(
                        row.actualAmountAtomic ?? row.expectedAmountAtomic,
                      )}{" "}
                      USDC
                      <small>
                        {row.paymentMode === "mock"
                          ? "模擬結算"
                          : row.paymentMode}
                      </small>
                    </td>
                    <td>
                      <Badge status={row.payment?.status} />
                    </td>
                    <td>
                      <span className="record-id">
                        {row.authorization?.paymentId ?? "—"}
                      </span>
                    </td>
                    <td>
                      <Badge status={row.invoice?.status} />
                      <small>
                        {row.invoice?.invoiceNumber ?? "尚無發票號碼"}
                      </small>
                    </td>
                    <td>
                      <Badge status={row.reconciliation?.status} />
                    </td>
                    <td>
                      <Link
                        className="text-button nowrap"
                        href={`/app/tasks/${row.taskId}?tab=records`}
                      >
                        查看憑證 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {resource.data && (
          <Pagination
            total={resource.data.total}
            offset={offset}
            setOffset={setOffset}
          />
        )}
      </section>
    </>
  );
}

export function PolicyPage({
  resource,
  controls,
}: {
  resource: ReturnType<typeof useResource<Settings>>;
  controls: ReturnType<typeof useResource<Control>>;
}) {
  const policy = resource.data?.policy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pending = useRef(false);
  async function freeze() {
    if (!controls.data || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api<Control>("/controls", {
        method: "PUT",
        body: JSON.stringify({ paymentsFrozen: !controls.data.paymentsFrozen }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("付款控制未能更新"));
    } finally {
      controls.refresh();
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="採購政策"
        description="查閱現行採購限制與核准供應商。歷史案件保留付款當時的政策快照。"
      >
        <span className="readonly-label">政策唯讀 · 付款控制可操作</span>
      </PageHeading>
      <ErrorMessage error={resource.error} autoRefresh />
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>新付款控制</h2>
        </div>
        <div className="control-content">
          <ErrorMessage error={error} />
          <p role="status">
            {controls.data
              ? controls.data.paymentsFrozen
                ? "目前已凍結新付款。"
                : "目前允許依政策送出新付款。"
              : "正在讀取付款控制…"}
          </p>
          <p>
            凍結會阻止新申請與尚未放行的付款；已取得送出許可的在途付款不會撤銷。設定保存在後端，畫面會自動更新。
          </p>
          <button
            className="workspace-button"
            disabled={busy || !controls.data || !!controls.error}
            onClick={() => void freeze()}
          >
            {busy
              ? "更新中…"
              : controls.data?.paymentsFrozen
                ? "解除新付款凍結"
                : "凍結新付款"}
          </button>
        </div>
      </section>
      {policy ? (
        <>
          <section className="workspace-panel">
            <div className="panel-heading">
              <h2>現行政策</h2>
              <span>版本 {policy.version}</span>
            </div>
            <dl className="policy-fields">
              <Field label="單筆金額上限">
                {money(policy.perTxLimitAtomic)} USDC
              </Field>
              <Field label="每日金額上限">
                {money(policy.dailyLimitAtomic)} USDC
              </Field>
              <Field label="台灣發票要求">
                {policy.requireTwInvoice ? "必須支援" : "依採購需求"}
              </Field>
              <Field label="允許網路" mono>
                {policy.allowedNetworks.join("、")}
              </Field>
            </dl>
          </section>
        </>
      ) : (
        !resource.error && (
          <Notice
            title={resource.loading ? "正在讀取政策…" : "尚未設定採購政策"}
          />
        )
      )}
    </>
  );
}

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const resource = useResource<PageResult<AuditEvent>>(
    `/audit-events?limit=20&offset=${offset}`,
  );
  return (
    <>
      <PageHeading
        title="稽核紀錄"
        description="查閱系統保留的採購事件與處理依據。"
      />
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>事件紀錄</h2>
          <span>依系統事件順序</span>
        </div>
        <ErrorMessage error={resource.error} autoRefresh />
        {resource.loading ? (
          <Notice title="正在讀取事件…" />
        ) : (
          resource.data && (
            <>
              <Events events={resource.data.items} />
              <Pagination
                total={resource.data.total}
                offset={offset}
                setOffset={setOffset}
              />
            </>
          )
        )}
      </section>
    </>
  );
}
