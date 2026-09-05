"use client";

import { useState } from "react";
import { MelloLogo } from "./mello-logo";
import { useMelloConsole } from "@/lib/use-mello-console";
import { displayTime, formatAmount, shortId } from "@/lib/api-client";

const promptDefault = "今天下午要決定能不能出貨給晨光貿易。幫我買一份企業信用風險報告，預算不超過 0.10 USDC。一定要能開台灣企業發票，買受人統編與成本中心依公司設定。超過 0.08 USDC 先問我。";
const steps = ["任務受理", "供應商比較", "政策檢核", "付款驗證", "發票對帳", "完成歸檔"];

export function MelloConsole() {
  const c = useMelloConsole();
  const [prompt, setPrompt] = useState(promptDefault);
  const [accessCode, setAccessCode] = useState("");
  const task = c.task;
  const purchase = task?.purchase;
  const status = task?.status ?? "DRAFT";
  const index = ({ CREATED: 0, PARSING: 0, DISCOVERING: 1, EVALUATING: 1, REJECTED: 2,
    AUTH_ANCHOR_PENDING: 2, PAYING: 3, DELIVERING: 3, INVOICING: 4, RECONCILING: 4,
    FINAL_ANCHOR_PENDING: 5, COMPLETED: 5, ACTION_REQUIRED: purchase?.payment?.status === "SETTLED" ? 4 : 2, FAILED: 2 } as Record<string, number>)[status] ?? 0;
  const allowed = purchase?.policyDecision?.approved === true;
  const hasPayment = purchase?.payment?.status === "SETTLED";
  const isMatched = status === "COMPLETED";
  const busy = c.busy;
  const frozen = c.control?.paymentsFrozen ?? false;
  const budget = task?.intent ? formatAmount(task.intent.maxAmount.atomic) : "依需求解析";
  const modes = purchase?.modes ?? c.health?.modes;
  const company = c.settings?.company;
  const policyStatus = allowed ? "ALLOW" : status === "REJECTED" ? "DENY" : task?.error?.code === "APPROVAL_REQUIRED" ? "待核准" : "待檢核";
  const events = task?.timeline ?? [];
  const approvalLimit = task?.control?.approvalLimitAtomic ? `${formatAmount(task.control.approvalLimitAtomic)} USDC` : task ? "未設定額外門檻" : "依需求解析";
  const selected = purchase?.selectedService;
  function reset() { c.reset(); setPrompt(promptDefault); }

  return (
    <main className="min-h-screen bg-[#e7e8e4] text-[#1b2836]">
      <div className="bg-[#1f3a56] px-4 py-1.5 text-[11px] tracking-[.08em] text-[#e7edf1] md:px-6">
        MELLO PROCUREMENT CONTROL SYSTEM　/　{modes?.payment === "x402" ? "BASE SEPOLIA TESTNET" : "MOCK ENVIRONMENT"}
      </div>

      <header className="border-b border-[#aeb5ba] bg-[#f9f9f6] px-4 py-3 md:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <MelloLogo light={false} />
            <div className="hidden border-l border-[#c8cccf] pl-5 md:block">
              <div className="text-sm font-bold tracking-[.04em]">代理採購與付款控制</div>
              <div className="mt-0.5 text-xs text-[#68737d]">Agent Purchase-to-Pay Control</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <div className="hidden text-right md:block">
              <div className="font-semibold">{company?.legalName ?? "企業採購操作台"}</div>
              <div className="text-[#68737d]">{company?.defaultCostCenter ?? "登入後載入公司資料"}</div>
            </div>
            <button disabled={busy} onClick={reset} className="enterprise-button" title="僅清空畫面，不刪除後端或鏈上紀錄">重置 Demo</button>
            {c.session === "authenticated" && <button disabled={c.working} onClick={() => void c.logout()} className="enterprise-button">登出</button>}
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-103px)] grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b border-[#aeb5ba] bg-[#d9dcd9] lg:border-b-0 lg:border-r">
          <div className="hidden border-b border-[#b7bcbf] px-5 py-4 text-xs text-[#56636e] lg:block">功能選單</div>
          <nav className="flex overflow-x-auto lg:block" aria-label="操作台導覽">
            {["採購工作台", "政策規則", "付款紀錄", "發票對帳", "稽核事件"].map((item, i) => (
              <a key={item} href={["#purchase", "#section-4", "#section-3", "#section-5", "#section-6"][i]} className={`min-w-max border-r border-[#bdc2c3] px-5 py-3 text-sm lg:block lg:border-b lg:border-r-0 ${i === 0 ? "bg-[#f7f7f2] font-bold text-[#183b5b]" : "text-[#4e5b65] hover:bg-[#e6e7e3]"}`}>
                <span className="mr-3 text-[11px] text-[#77828a]">0{i + 1}</span>{item}
              </a>
            ))}
          </nav>
          <div className="m-4 hidden border border-[#aeb5ba] bg-[#ecece7] p-3 text-xs leading-5 text-[#5c6770] lg:block">
            <b className="text-[#263746]">系統狀態</b><br />
            Base Sepolia / USDC<br />
            Facilitator：{modes?.payment === "x402" ? "LIVE x402" : "MOCK"}<br />
            發票介接：{modes?.invoice ?? "—"}<br />
            稽核錨定：{modes?.anchor ?? "—"}<br />
            Health：{c.health?.status ?? "尚未連線"}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="border-b border-[#bbc0c2] bg-[#f4f4ef] px-4 py-2 text-xs text-[#66727c] md:px-6">
            首頁　›　風險管理　›　企業信用報告採購
          </div>

          <div className="px-4 py-5 md:px-6 lg:px-8">
            {c.session === "anonymous" && <form className="mb-4 border border-[#aeb5ba] bg-[#f9f9f6] p-4" onSubmit={event => { event.preventDefault(); void c.login(accessCode).then(() => setAccessCode("")); }}>
              <label htmlFor="demo-access-code" className="mb-2 block text-sm font-bold">登入採購操作台</label>
              <div className="flex flex-wrap gap-2"><input id="demo-access-code" type="password" autoComplete="current-password" value={accessCode} onChange={event => setAccessCode(event.target.value)} required className="min-h-10 border border-[#9da6ab] bg-white px-3 text-sm" aria-describedby="login-hint" /><button disabled={c.working} className="enterprise-button primary" type="submit">登入</button></div>
              <p id="login-hint" className="mt-2 text-xs text-[#68737d]">使用管理員提供的存取碼。測試網付款需要登入；錢包私鑰不會傳入瀏覽器。</p>
            </form>}
            {c.loading && <div className="mb-4 border border-[#aeb5ba] bg-[#eef0ed] p-4 text-sm" role="status">正在載入公司、政策與系統狀態…</div>}
            {c.error && <div className="mb-4 border border-[#c98a84] bg-[#fff0ee] p-4 text-sm text-[#923b33]" role="alert">{c.error}<button className="enterprise-button ml-3" disabled={c.working} onClick={() => void c.refresh()}>重新整理狀態</button></div>}
            {c.notice && <div className="mb-4 border border-[#aeb5ba] bg-[#eef0ed] p-3 text-xs" role="status">{c.notice}</div>}
            <div className="flex flex-col justify-between gap-4 border-b-2 border-[#263f58] pb-4 md:flex-row md:items-end">
              <div>
                <div className="text-xs text-[#68747d]" title={task?.taskId}>採購案件編號　{shortId(task?.taskId)}</div>
                <h1 className="mt-1 text-2xl font-bold tracking-[.01em]">企業信用風險報告採購</h1>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="border border-[#b7bec2] bg-[#f7f7f3] px-3 py-1.5">資料來源　API</span>
                <span data-testid="task-status"><StatusBadge tone={isMatched ? "green" : status === "REJECTED" || status === "FAILED" ? "red" : "blue"}>{isMatched ? "處理完成" : busy ? "處理中" : status === "DRAFT" ? "草稿" : status} · {status}</StatusBadge></span>
              </div>
            </div>

            <div className="mt-4 border border-[#c3aa63] bg-[#fff7d9] px-4 py-3 text-sm text-[#4f4528]">
              <b>出貨決策待辦：</b>依{task?.intent?.targetCompanyName ?? "採購目標企業"}的信用風險報告評估出貨，付款與發票證據以本案後端紀錄為準。
            </div>

            <section className="mt-4 overflow-x-auto border border-[#aeb5ba] bg-[#f8f8f5]" aria-label="處理進度">
              <div className="grid min-w-[760px] grid-cols-6">
                {steps.map((label, i) => (
                  <div key={label} className={`border-r border-[#c6cbcd] px-3 py-2.5 last:border-r-0 ${i <= index ? "bg-[#e5eee7]" : "bg-[#eceeea]"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`grid h-5 w-5 place-items-center border text-[10px] font-bold ${i <= index ? "border-[#3c7550] bg-[#497e5a] text-white" : "border-[#9da5a9] text-[#778188]"}`}>{i < index ? "✓" : i + 1}</span>
                      <span className={`text-xs font-semibold ${i <= index ? "text-[#2b5e3d]" : "text-[#69747b]"}`}>{label}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.55fr)]">
              <div className="min-w-0 space-y-5">
                <Panel id="purchase" code="A-01" title="採購申請內容" meta={company?.defaultCostCenter ?? "公司資料載入後顯示"}>
                  <div className="grid border-b border-[#c6cbcd] md:grid-cols-4">
                    <Field label="申請公司" value={company?.legalName ?? "—"} />
                    <Field label="公司統編" value={company?.businessId ?? "—"} />
                    <Field label="成本中心" value={company?.defaultCostCenter ?? "—"} />
                    <Field label="預算上限" value={`${budget} USDC`} />
                  </div>
                  <div className="p-4">
                    <label className="mb-2 block text-xs font-bold text-[#4e5d69]" htmlFor="purchase-request">採購需求說明</label>
                    <textarea id="purchase-request" value={task?.prompt ?? prompt} disabled={busy || !!task} onChange={(event) => setPrompt(event.target.value)} minLength={3} maxLength={2000} className="min-h-32 w-full resize-y border border-[#9da6ab] bg-white p-3 text-sm leading-6 outline-none focus:border-[#315a79] focus:ring-1 focus:ring-[#315a79]" aria-label="採購任務" />
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Tag>核准門檻 {approvalLimit}</Tag><Tag>台灣企業發票必備</Tag><Tag>Base Sepolia</Tag><Tag>USDC</Tag>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-[#d0d3d3] pt-4">
                      <button disabled={busy || frozen || !c.ready || (!!task && task.status !== "CREATED")} aria-busy={busy} onClick={() => void (task?.status === "CREATED" ? c.resume() : c.start(prompt))} className="enterprise-button primary">{busy ? "Agent 執行中…" : frozen ? "新付款已凍結" : task?.status === "CREATED" ? "繼續執行既有任務" : task ? "任務已建立 · 重置以新增" : "執行採購任務 →"}</button>
                      <button disabled={busy || frozen || !c.ready} onClick={() => void c.start("幫我買一份 晨光貿易 的信用報告，預算 0.03 USDC，要開統編發票。")} className="enterprise-button">測試 0.03 預算</button>
                      <button disabled={busy || frozen || !c.ready} onClick={() => void c.start(prompt, "0x0000000000000000000000000000000000000001")} className="enterprise-button">測試 payTo 不符</button>
                    </div>
                  </div>
                </Panel>

                <Panel id="section-2" code="A-02" title="供應商比較結果" meta={`Registry：${c.settings?.services.length ?? 0} 筆服務`}>
                  <div className="overflow-x-auto">
                    <table className="enterprise-table min-w-[720px]">
                      <thead><tr><th>供應商／服務</th><th>報價</th><th>發票能力</th><th>白名單</th><th>payTo</th><th>系統判定</th></tr></thead>
                      <tbody>
                        {!c.settings?.services.length && <tr><td colSpan={6}>{c.loading ? "正在載入供應商…" : "登入後載入供應商 registry"}</td></tr>}
                        {c.settings?.services.map(service => {
                          const candidate = task?.candidates?.find(item => item.serviceId === service.id);
                          return <tr key={service.id} className={candidate ? candidate.eligible ? "bg-[#edf6ef]" : "bg-[#fff0ee]" : ""}>
                            <td><b>{service.sellerLegalName}</b><small>{service.id}</small></td><td className="number-cell">{formatAmount(service.priceAtomic)} USDC</td>
                            <td>{service.supportsTwInvoice ? "tw-einvoice（demo）" : "不支援"}</td><td>{c.settings!.policy.allowedSellerIds.includes(service.sellerId) ? "是" : "否"}</td>
                            <td title={service.payToAddress}>{shortId(service.payToAddress)}</td><td title={candidate?.humanSummary}>{candidate ? <StatusBadge tone={candidate.eligible ? "green" : "red"}>{selected?.id === service.id ? "選用" : candidate.eligible ? "符合條件" : "拒絕"}</StatusBadge> : "待比較"}{candidate && !candidate.eligible && <small>{candidate.reasonCodes.join(" / ")}</small>}</td>
                          </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="grid gap-px border-t border-[#c4c9cb] bg-[#c4c9cb] text-xs md:grid-cols-4">
                    {["taskStatus", "selectedServiceId", "reasonCodes", "policyVersion"].map((key, i) => <div key={key} className="bg-[#eef0ed] px-3 py-2"><span className="block text-[10px] text-[#748089]">{key}</span><b>{[status, selected?.id ?? "—", task?.candidates?.flatMap(item => item.reasonCodes).length ?? "—", purchase?.policySnapshot?.version ?? c.settings?.policy.version ?? "—"][i]}</b></div>)}
                  </div>
                </Panel>

                <Panel id="section-3" code="A-03" title="付款與交付證據" meta={`Payment ID：${shortId(purchase?.paymentAuthorization?.paymentId)}`}>
                  <div className="overflow-x-auto">
                    <table className="enterprise-table min-w-[700px]">
                      <thead><tr><th>順序</th><th>事件</th><th>識別資料</th><th>狀態</th><th>時間</th></tr></thead>
                      <tbody>
                        {events.filter(event => /PAYMENT|SETTLEMENT|DELIVERY/.test(event.eventType)).slice(-5).map(event => <tr key={event.id}>
                          <td className="number-cell">{event.sequence}</td><td>{event.eventType}</td><td className="font-mono text-xs" title={event.id}>{shortId(event.id)}</td><td><StatusBadge tone="blue">已記錄</StatusBadge></td><td className="number-cell">{displayTime(event.createdAt)}</td>
                        </tr>)}
                        {!events.some(event => /PAYMENT|SETTLEMENT|DELIVERY/.test(event.eventType)) && <tr><td colSpan={5}>尚無付款證據。建立並執行採購後，這裡會顯示實際事件。</td></tr>}
                        <tr><td>TX</td><td>Base Sepolia transaction</td><td className="font-mono text-xs" data-testid="payment-hash"><TransactionLink base={purchase?.explorerLinks.payment} hash={purchase?.payment?.transactionHash} /></td><td>{purchase?.payment?.status ?? "NOT_STARTED"}</td><td>{modes?.payment === "x402" ? "鏈上驗證" : "MOCK"}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-[#c3aa63] bg-[#fff7d9] px-4 py-2 text-xs text-[#5f522c]">{modes?.payment === "x402" ? "BASE SEPOLIA TESTNET — 會移轉測試網 USDC，非主網資產；稽核錨定另耗用測試 ETH。" : "MOCK SETTLEMENT — 模擬付款，不移轉鏈上資金。"}</div>
                  <details className="border-t border-[#aeb5ba] p-4 text-xs"><summary className="cursor-pointer font-bold">完整付款與報告證據</summary>
                    <p className="my-2 break-all">Logical Payment ID：{purchase?.paymentAuthorization?.paymentId ?? "—"}</p>
                    <p className="my-2 break-all">收款地址：{purchase?.payToAddress ?? "—"}</p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-[#eef0ed] p-3">{purchase?.delivery?.status === "DELIVERED" ? JSON.stringify(purchase.delivery.responseBody, null, 2) : "服務尚未交付，不顯示付費內容。"}</pre>
                  </details>
                  <div className="border-t border-[#aeb5ba] px-4 py-3 text-xs" data-testid="anchor-evidence"><b>合約稽核錨定</b>{purchase?.anchors.filter(anchor => anchor.kind !== "FAIL" || anchor.status !== "NOT_STARTED").map(anchor => <div key={anchor.kind} className="mt-2 flex flex-wrap gap-2"><span>{anchor.kind}</span><span>{anchor.status}</span><TransactionLink base={purchase.explorerLinks.anchor} hash={anchor.transactionHash} /></div>) ?? <p className="mt-2">尚無錨定紀錄。</p>}</div>
                </Panel>
              </div>

              <div className="min-w-0 space-y-5">
                <Panel id="section-4" code="B-01" title="政策檢核" meta="Hard rules">
                  <div className={`flex items-center justify-between border-b px-4 py-3 ${index < 2 ? "border-[#c6cbcd] bg-[#eceeea]" : allowed ? "border-[#7ea88a] bg-[#e5f1e8]" : "border-[#c98a84] bg-[#f8e7e5]"}`}>
                    <div><div className="text-[10px] text-[#63717a]">POLICY RESULT</div><b className="text-lg">{policyStatus}</b></div>
                    <StatusBadge tone={allowed ? "green" : status === "REJECTED" ? "red" : "blue"}>{policyStatus}</StatusBadge>
                  </div>
                  <div className="divide-y divide-[#d0d4d5]">
                    {[
                      ["Amount", `${formatAmount(purchase?.expectedAmountAtomic)} / 上限 ${budget}`, allowed],
                      ["Approval", task?.control?.approvedAt ? "已人工核准" : approvalLimit, allowed],
                      ["Network / Asset", "Base Sepolia · USDC", allowed],
                      ["Seller", selected?.sellerLegalName ?? "待選用", allowed],
                      ["payTo", task?.error?.message?.includes("PAY_TO_MISMATCH") ? "PAY_TO_MISMATCH" : selected ? "Registry exact match" : "待檢核", allowed],
                      ["Invoice", "tw-einvoice（demo）", allowed],
                    ].map(([rule, detail, pass]) => <div key={String(rule)} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2.5 text-xs"><div><b>{rule}</b><span className="ml-2 text-[#68747d]">{detail}</span></div><b className={pass ? "text-[#35714a]" : "text-[#68747d]"}>{pass ? "PASS" : "待檢核"}</b></div>)}
                  </div>
                  {task?.error && <div className="border-t border-[#c98a84] bg-[#fff0ee] px-4 py-3 text-xs font-bold text-[#963a32]" data-testid="task-error">{task.error.code} · {task.error.message ?? task.decisionSummary}{!purchase && " · 無付款"}</div>}
                  {task?.error?.code === "APPROVAL_REQUIRED" && <div className="border-t border-[#aeb5ba] p-4 text-xs"><p className="mb-3 break-all">核准 {task.control?.pendingTerms?.serviceId}，金額 {formatAmount(task.control?.pendingTerms?.amountAtomic)} USDC，收款地址 {task.control?.pendingTerms?.payTo}。</p><button disabled={busy || frozen} onClick={() => void c.retry("approve")} className="enterprise-button primary">核准此筆採購</button></div>}
                </Panel>

                <Panel id="section-5" code="B-02" title="三方對帳" meta="Payment / Service / Invoice">
                  <div className="divide-y divide-[#cbd0d1]">
                    <EvidenceRow label="付款" status={purchase?.payment?.status ?? "NOT_STARTED"} detail={`${formatAmount(purchase?.expectedAmountAtomic)} USDC · ${shortId(purchase?.paymentAuthorization?.paymentId)}`} active={hasPayment} />
                    <EvidenceRow label="服務" status={purchase?.delivery?.status ?? "PENDING"} detail={task?.intent?.targetCompanyName ?? "等待採購目標"} active={purchase?.delivery?.status === "DELIVERED"} />
                    <EvidenceRow label="發票" status={purchase?.invoice?.status ?? "PENDING"} detail={`統編 ${(purchase ? purchase.invoice?.buyerBusinessId : company?.businessId) ?? "—"} · ${purchase?.invoice?.invoiceNumber ?? "尚未開立"}`} active={purchase?.invoice?.status === "ISSUED_DEMO"} />
                  </div>
                  <div className="border-t border-[#c3aa63] bg-[#fff7d9] px-4 py-2 text-[11px] font-bold text-[#5f522c]">SANDBOX / TEST INVOICE — 非財政部有效發票</div>
                  <div className={`flex items-center justify-between border-t px-4 py-4 ${isMatched ? "border-[#7ea88a] bg-[#e5f1e8]" : "border-[#c8cdce] bg-[#eceeea]"}`}>
                    <span className="text-xs font-bold">RECONCILIATION</span>
                    <StatusBadge tone={purchase?.reconciliation?.status === "MATCHED" ? "green" : "blue"}>{purchase?.reconciliation?.status ?? "PENDING"}</StatusBadge>
                  </div>
                  {purchase && <div className="flex flex-wrap gap-2 border-t border-[#aeb5ba] p-4">
                    {purchase.availableActions.retryInvoice && <button disabled={busy} onClick={() => void c.retry("retry-invoice")} className="enterprise-button primary">重試發票（不重付）</button>}
                    {purchase.availableActions.retryAnchor && <button disabled={busy} onClick={() => void c.retry("retry-anchor")} className="enterprise-button">重試稽核錨定</button>}
                    {purchase.availableActions.reconcilePayment && <button disabled={busy} onClick={() => void c.retry("reconcile-payment")} className="enterprise-button">核對未確定付款</button>}
                    <details className="w-full text-xs"><summary className="cursor-pointer">發票資料</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(purchase.invoice, null, 2)}</pre></details>
                  </div>}
                </Panel>

                <Panel id="section-6" code="B-03" title="稽核事件" meta="Audit trail">
                  <div className="divide-y divide-[#cdd1d2]">
                    {events.length === 0 && <div className="p-4 text-xs text-[#68747d]">尚無事件。執行採購後顯示後端稽核時間與狀態。</div>}
                    {events.slice(-6).map(event => <AuditRow key={event.id} time={new Date(event.createdAt).toLocaleTimeString("zh-TW", { hour12: false })} title={event.eventType} detail={`事件序號 ${event.sequence}`} active />)}
                  </div>
                  <div className="space-y-2 border-t border-[#cbd0d1] p-4">
                    <button disabled={!isMatched || busy || !c.ready} onClick={() => void c.duplicate()} className="enterprise-button w-full text-left">模擬財務 Agent 重複下單</button>
                    <button disabled={!c.ready || c.working} onClick={() => void c.freeze()} className={`enterprise-button w-full text-left ${frozen ? "danger" : ""}`}>{frozen ? "付款已凍結 · 點擊解除" : "凍結所有新付款"}</button>
                    <p className="text-[11px] leading-5 text-[#647079]">相同採購請求編號共用一筆付款。凍結會拒絕新的送出許可，不撤銷已在途付款。</p>
                    <details className="text-xs"><summary className="cursor-pointer py-2 font-bold">採購紀錄（{c.history.length}）</summary>
                      {c.history.length === 0 ? <p className="py-2">尚無採購紀錄。</p> : c.history.map(item => <button key={item.taskId} disabled={busy} className="enterprise-button mt-2 w-full text-left" onClick={() => c.selectTask(item.taskId)}>{shortId(item.taskId)} · {item.status}<small className="mt-1 block">{displayTime(item.createdAt)}</small></button>)}
                    </details>
                    <details className="text-xs"><summary className="cursor-pointer py-2 font-bold">完整稽核紀錄</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(events, null, 2)}</pre></details>
                  </div>
                </Panel>
              </div>
            </div>
          </div>

          <footer className="border-t border-[#b5bbbd] bg-[#dfe1de] px-6 py-2 text-[11px] text-[#647079]">Mello v0.1　｜　資料更新時間：{displayTime(task?.updatedAt ?? c.health?.checkedAt)}　｜　付款：{modes?.payment ?? "—"} / 發票：{modes?.invoice ?? "—"} / 錨定：{modes?.anchor ?? "—"}</footer>
        </div>
      </div>
    </main>
  );
}

function Panel({ id, code, title, meta, children }: { id: string; code: string; title: string; meta: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-4 border border-[#aeb5ba] bg-[#f9f9f6]"><header className="flex items-center justify-between gap-3 border-b border-[#aeb5ba] bg-[#dfe2df] px-4 py-2.5"><div className="flex items-center gap-3"><span className="font-mono text-[10px] text-[#69757d]">{code}</span><h2 className="text-sm font-bold">{title}</h2></div><span className="hidden text-[10px] text-[#6c777e] sm:block">{meta}</span></header>{children}</section>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-[#c6cbcd] p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><div className="text-[10px] text-[#68747d]">{label}</div><div className="mt-1 text-sm font-bold">{value}</div></div>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="border border-[#aeb6ba] bg-[#eef0ed] px-2.5 py-1 text-[#475762]">{children}</span>;
}

function StatusBadge({ tone, children }: { tone: "green" | "red" | "blue"; children: React.ReactNode }) {
  const toneClass = tone === "green" ? "border-[#6c9b78] bg-[#e3f0e6] text-[#2f6741]" : tone === "red" ? "border-[#c68179] bg-[#f7e5e2] text-[#923b33]" : "border-[#8295a5] bg-[#e6ebef] text-[#34536c]";
  return <span className={`inline-flex min-h-6 items-center border px-2 text-[10px] font-bold tracking-[.05em] ${toneClass}`}>{children}</span>;
}

function EvidenceRow({ label, status, detail, active }: { label: string; status: string; detail: string; active: boolean }) {
  return <div className="grid grid-cols-[64px_1fr] gap-3 px-4 py-3"><span className="text-xs text-[#64717a]">{label}</span><div><b className={`text-xs ${active ? "text-[#316b43]" : "text-[#737d83]"}`}>{status}</b><div className="mt-1 text-[11px] text-[#778187]">{detail}</div></div></div>;
}

function AuditRow({ time, title, detail, active }: { time: string; title: string; detail: string; active: boolean }) {
  return <div className={`grid grid-cols-[42px_minmax(0,1fr)] gap-3 px-4 py-3 ${active ? "opacity-100" : "opacity-55"}`}><span className="font-mono text-[10px] text-[#6f7a81]">{time}</span><div><b className="break-all text-xs">{title}</b><div className="mt-1 text-[11px] text-[#6c777e]">{detail}</div></div></div>;
}

function TransactionLink({ base, hash }: { base?: string | null; hash?: string | null }) {
  if (!hash) return <span>—</span>;
  const remote = base && /^https:\/\/(sepolia\.)?basescan\.org\/?$/.test(base);
  return remote ? <a className="underline" title={hash} href={`${base!.replace(/\/$/, "")}/tx/${hash}`} target="_blank" rel="noopener noreferrer">{shortId(hash)}</a> : <span title={hash}>{shortId(hash)}（mock/local）</span>;
}
