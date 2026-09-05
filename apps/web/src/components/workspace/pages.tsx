"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  api,
  dateTime,
  money,
  running,
  shortId,
  type AuditEvent,
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
          <button className="text-button" onClick={resource.refresh}>
            重新整理
          </button>
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
              <option value="CREATED">待送出</option>
              <option value="processing">處理中</option>
              <option value="COMPLETED">已完成</option>
              <option value="ACTION_REQUIRED">待處理</option>
              <option value="REJECTED">未核准</option>
              <option value="FAILED">處理失敗</option>
            </select>
          </label>
        </div>
        <ErrorMessage error={resource.error} retry={resource.refresh} />
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

export function NewRequest({ settings }: { settings: Settings | null }) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [budget, setBudget] = useState("0.10");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const prompt = `幫我買一份 ${target.trim()} 的信用報告，預算 ${budget} USDC，要開統編發票。${notes.trim() ? `\n補充需求：${notes.trim()}` : ""}`;
      const result = await api<{ taskId: string }>("/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
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
        description="填寫需求並建立案件，確認後再送出採購。"
      >
        <Link href="/app" className="workspace-button">
          返回清單
        </Link>
      </PageHeading>
      <ErrorMessage error={error} />
      <form className="request-form" onSubmit={submit}>
        <section className="workspace-panel">
          <div className="panel-heading">
            <h2>採購需求</h2>
            <span>＊ 必填</span>
          </div>
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor="service">服務類型</label>
              <input id="service" value="企業信用風險報告" readOnly />
              <small>目前可採購的服務項目。</small>
            </div>
            <div className="form-field">
              <label htmlFor="target">
                查詢企業名稱 <span>＊</span>
              </label>
              <input
                id="target"
                name="target"
                autoComplete="off"
                placeholder="例如：晨光貿易"
                required
                maxLength={100}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                pattern=".*\S.*"
              />
            </div>
            <div className="form-field">
              <label htmlFor="budget">
                預算上限 <span>＊</span>
              </label>
              <div className="amount-input">
                <input
                  id="budget"
                  name="budget"
                  type="number"
                  inputMode="decimal"
                  min="0.000001"
                  max="1000000"
                  step="0.000001"
                  required
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <span>USDC</span>
              </div>
              <small>以實際報價付款，且須符合公司採購政策。</small>
            </div>
            <div className="form-field">
              <label htmlFor="notes">
                補充需求 <span className="optional">選填</span>
              </label>
              <textarea
                id="notes"
                rows={4}
                maxLength={1000}
                placeholder="例如：用於本次出貨前的信用風險評估。"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <small>金額與發票資料請以上方預算及公司設定為準。</small>
            </div>
          </div>
          <div className="form-footer">
            <span>建立申請不會立即付款。</span>
            <button
              className="workspace-button primary"
              disabled={busy || !settings?.company || !settings?.policy}
            >
              {busy ? "建立中…" : "建立申請"}
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
              <Field label="發票要求">台灣企業發票</Field>
            </dl>
            <p className="panel-note">發票抬頭與成本中心沿用公司設定。</p>
          </section>
          <section className="form-guidance">
            <h2>送出前，先確認</h2>
            <p>
              建立後可查看完整需求。點選「送出採購」才會進行供應商評估與付款。
            </p>
            <p>報價或發票能力不符時，系統會保留拒絕原因。</p>
          </section>
        </aside>
      </form>
    </>
  );
}

export function PurchaseList({ invoices = false }: { invoices?: boolean }) {
  const [offset, setOffset] = useState(0);
  const resource = useResource<PageResult<Purchase>>(
    `/purchases?limit=20&offset=${offset}`,
  );
  return (
    <>
      <PageHeading
        title={invoices ? "發票與對帳" : "付款紀錄"}
        description={
          invoices
            ? "核對付款、服務交付與發票，追蹤待處理項目。"
            : "查看各筆採購的授權、結算狀態與付款識別碼。"
        }
      >
        <button className="workspace-button" onClick={resource.refresh}>
          重新整理
        </button>
      </PageHeading>
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>{invoices ? "憑證清單" : "付款清單"}</h2>
          <span>依建立時間排序</span>
        </div>
        <ErrorMessage error={resource.error} retry={resource.refresh} />
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
                  <th>{invoices ? "發票" : "付款"}狀態</th>
                  <th>{invoices ? "對帳狀態" : "付款識別碼"}</th>
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
                        {row.selectedService.sellerLegalName}
                      </strong>
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
                      <Badge
                        status={
                          invoices ? row.invoice?.status : row.payment?.status
                        }
                      />
                      {invoices && (
                        <small>
                          {row.invoice?.invoiceNumber ?? "尚無發票號碼"}
                        </small>
                      )}
                    </td>
                    <td>
                      {invoices ? (
                        <Badge status={row.reconciliation?.status} />
                      ) : (
                        <span className="record-id">
                          {row.authorization?.paymentId ?? "—"}
                        </span>
                      )}
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
      {invoices && (
        <p className="page-footnote">
          SANDBOX · 測試發票僅供介接與流程驗證，不具正式發票效力。
        </p>
      )}
    </>
  );
}

export function PolicyPage({
  resource,
}: {
  resource: ReturnType<typeof useResource<Settings>>;
}) {
  const policy = resource.data?.policy;
  return (
    <>
      <PageHeading
        title="採購政策"
        description="查閱現行採購限制與核准供應商。歷史案件保留付款當時的政策快照。"
      >
        <span className="readonly-label">唯讀</span>
      </PageHeading>
      <ErrorMessage error={resource.error} retry={resource.refresh} />
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
          <section className="workspace-panel">
            <div className="panel-heading">
              <h2>已登錄服務</h2>
              <span>由供應商登錄資料決定收款地址</span>
            </div>
            <div className="table-scroll">
              <table className="records-table">
                <thead>
                  <tr>
                    <th>供應商</th>
                    <th>報價</th>
                    <th>台灣發票</th>
                    <th>政策白名單</th>
                    <th>登錄收款地址</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data?.services.map((service) => (
                    <tr key={service.id}>
                      <td>
                        <strong>{service.sellerLegalName}</strong>
                        <small>{service.id}</small>
                      </td>
                      <td className="nowrap">
                        {money(service.priceAtomic)} USDC
                      </td>
                      <td>
                        {service.supportsTwInvoice ? "支援測試介接" : "不支援"}
                      </td>
                      <td>
                        {policy.allowedSellerIds.includes(service.sellerId)
                          ? "已列入"
                          : "未列入"}
                      </td>
                      <td className="record-id">{service.payToAddress}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="page-footnote">
            本頁提供查閱；目前未提供政策編輯或人工審批操作。
          </p>
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
      >
        <button className="workspace-button" onClick={resource.refresh}>
          重新整理
        </button>
      </PageHeading>
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>事件紀錄</h2>
          <span>依系統事件順序</span>
        </div>
        <ErrorMessage error={resource.error} retry={resource.refresh} />
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
