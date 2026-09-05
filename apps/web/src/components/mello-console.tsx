"use client";

import { useState } from "react";
import { MelloLogo } from "./mello-logo";

type Stage = "idle" | "compare" | "policy" | "pay" | "matched" | "duplicate" | "denied" | "mismatch";

const promptDefault = "今天下午要決定能不能出貨給晨光貿易。幫我買一份企業信用風險報告，預算不超過 0.10 USDC。一定要能開台灣企業發票，統編開給青葉電子 53887711，費用記風險管理部。超過 0.08 USDC 先問我。";
const steps = ["任務受理", "供應商比較", "政策檢核", "付款驗證", "發票對帳", "完成歸檔"];

export function MelloConsole() {
  const [stage, setStage] = useState<Stage>("idle");
  const [prompt, setPrompt] = useState(promptDefault);
  const [budget, setBudget] = useState("0.10");
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);

  const index = stage === "idle" ? 0 : stage === "compare" ? 1 : stage === "policy" || stage === "denied" || stage === "mismatch" ? 2 : stage === "pay" ? 3 : stage === "matched" ? 5 : 5;
  const allowed = !["denied", "mismatch"].includes(stage);
  const hasPayment = ["pay", "matched", "duplicate"].includes(stage);
  const isMatched = ["matched", "duplicate"].includes(stage);

  function run(next: Stage = Number(budget) < 0.05 ? "denied" : "matched") {
    setBusy(true);
    setStage("compare");
    window.setTimeout(() => setStage(next === "denied" || next === "mismatch" ? next : "policy"), 450);
    if (next !== "denied" && next !== "mismatch") {
      window.setTimeout(() => setStage("pay"), 900);
      window.setTimeout(() => {
        setStage(next);
        setBusy(false);
      }, 1400);
    } else {
      window.setTimeout(() => setBusy(false), 650);
    }
  }

  function reset() {
    setStage("idle");
    setBudget("0.10");
    setFrozen(false);
    setBusy(false);
  }

  const policyStatus = index < 2 ? "待檢核" : allowed ? "ALLOW" : "DENY";

  return (
    <main className="min-h-screen bg-[#e7e8e4] text-[#1b2836]">
      <div className="bg-[#1f3a56] px-4 py-1.5 text-[11px] tracking-[.08em] text-[#e7edf1] md:px-6">
        MELLO PROCUREMENT CONTROL SYSTEM　/　SANDBOX ENVIRONMENT
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
              <div className="font-semibold">青葉電子股份有限公司</div>
              <div className="text-[#68737d]">風險管理部　林佳穎</div>
            </div>
            <button onClick={reset} className="enterprise-button">重置 Demo</button>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-103px)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-[#aeb5ba] bg-[#d9dcd9] lg:border-b-0 lg:border-r">
          <div className="hidden border-b border-[#b7bcbf] px-5 py-4 text-xs text-[#56636e] lg:block">功能選單</div>
          <nav className="flex overflow-x-auto lg:block" aria-label="操作台導覽">
            {["採購工作台", "政策規則", "付款紀錄", "發票對帳", "稽核事件"].map((item, i) => (
              <a key={item} href={i === 0 ? "#purchase" : `#section-${i + 1}`} className={`min-w-max border-r border-[#bdc2c3] px-5 py-3 text-sm lg:block lg:border-b lg:border-r-0 ${i === 0 ? "bg-[#f7f7f2] font-bold text-[#183b5b]" : "text-[#4e5b65] hover:bg-[#e6e7e3]"}`}>
                <span className="mr-3 text-[11px] text-[#77828a]">0{i + 1}</span>{item}
              </a>
            ))}
          </nav>
          <div className="m-4 hidden border border-[#aeb5ba] bg-[#ecece7] p-3 text-xs leading-5 text-[#5c6770] lg:block">
            <b className="text-[#263746]">系統狀態</b><br />
            Base Sepolia / USDC<br />
            Facilitator：SIMULATED<br />
            發票介接：SANDBOX
          </div>
        </aside>

        <div className="min-w-0">
          <div className="border-b border-[#bbc0c2] bg-[#f4f4ef] px-4 py-2 text-xs text-[#66727c] md:px-6">
            首頁　›　風險管理　›　企業信用報告採購
          </div>

          <div className="px-4 py-5 md:px-6 lg:px-8">
            <div className="flex flex-col justify-between gap-4 border-b-2 border-[#263f58] pb-4 md:flex-row md:items-end">
              <div>
                <div className="text-xs text-[#68747d]">採購案件編號　PI-20260905-017</div>
                <h1 className="mt-1 text-2xl font-bold tracking-[.01em]">企業信用風險報告採購</h1>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="border border-[#b7bec2] bg-[#f7f7f3] px-3 py-1.5">截止時間　17:00</span>
                <StatusBadge tone={isMatched ? "green" : "blue"}>{isMatched ? "處理完成" : busy ? "處理中" : "草稿"}</StatusBadge>
              </div>
            </div>

            <div className="mt-4 border border-[#c3aa63] bg-[#fff7d9] px-4 py-3 text-sm text-[#4f4528]">
              <b>出貨決策待辦：</b>今天 17:00 前確認晨光貿易（統編 12345678）是否可出第一批貨。
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
                <Panel id="purchase" code="A-01" title="採購申請內容" meta="申請人：風險 林佳穎">
                  <div className="grid border-b border-[#c6cbcd] md:grid-cols-4">
                    <Field label="申請公司" value="青葉電子" />
                    <Field label="公司統編" value="53887711" />
                    <Field label="成本中心" value="風險管理部" />
                    <Field label="預算上限" value={`${budget} USDC`} />
                  </div>
                  <div className="p-4">
                    <label className="mb-2 block text-xs font-bold text-[#4e5d69]" htmlFor="purchase-request">採購需求說明</label>
                    <textarea id="purchase-request" value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-32 w-full resize-y border border-[#9da6ab] bg-white p-3 text-sm leading-6 outline-none focus:border-[#315a79] focus:ring-1 focus:ring-[#315a79]" aria-label="採購任務" />
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Tag>核准門檻 0.08 USDC</Tag><Tag>台灣企業發票必備</Tag><Tag>Base Sepolia</Tag><Tag>USDC</Tag>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-[#d0d3d3] pt-4">
                      <button disabled={busy || frozen} onClick={() => run()} className="enterprise-button primary">{busy ? "Agent 執行中…" : frozen ? "新付款已凍結" : "執行採購任務 →"}</button>
                      <button onClick={() => { setBudget("0.03"); run("denied"); }} className="enterprise-button">測試 0.03 預算</button>
                      <button onClick={() => run("mismatch")} className="enterprise-button">測試 payTo 不符</button>
                    </div>
                  </div>
                </Panel>

                <Panel id="section-2" code="A-02" title="供應商比較結果" meta="Registry：2 筆符合服務類型">
                  <div className="overflow-x-auto">
                    <table className="enterprise-table min-w-[720px]">
                      <thead><tr><th>供應商／服務</th><th>報價</th><th>發票能力</th><th>白名單</th><th>payTo</th><th>系統判定</th></tr></thead>
                      <tbody>
                        <tr className={index >= 1 ? "bg-[#fff0ee]" : ""}><td><b>GlobalData API</b><small>全球企業資料報告</small></td><td className="number-cell">0.04 USDC</td><td>不支援</td><td>否</td><td>未綁定</td><td>{index >= 1 ? <StatusBadge tone="red">拒絕</StatusBadge> : "待比較"}</td></tr>
                        <tr className={index >= 1 ? "bg-[#edf6ef]" : ""}><td><b>TaiwanRisk API</b><small>台灣企業信用風險報告</small></td><td className="number-cell">0.05 USDC</td><td>tw-einvoice</td><td>是</td><td>Registry 一致</td><td>{index >= 1 ? <StatusBadge tone="green">選用</StatusBadge> : "待比較"}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="grid gap-px border-t border-[#c4c9cb] bg-[#c4c9cb] text-xs md:grid-cols-4">
                    {["recommendedAction", "selectedServiceId", "reasonCodes", "confidence"].map((key, i) => <div key={key} className="bg-[#eef0ed] px-3 py-2"><span className="block text-[10px] text-[#748089]">{key}</span><b>{["PURCHASE", "taiwanrisk", "3", "0.99"][i]}</b></div>)}
                  </div>
                </Panel>

                <Panel id="section-3" code="A-03" title="付款與交付證據" meta="Logical Payment ID：pay_mello_001">
                  <div className="overflow-x-auto">
                    <table className="enterprise-table min-w-[700px]">
                      <thead><tr><th>順序</th><th>事件</th><th>識別資料</th><th>狀態</th><th>時間</th></tr></thead>
                      <tbody>
                        {["402 payment required", "payment fingerprint locked", "facilitator verify", "Base Sepolia transaction", "service receipt"].map((event, i) => (
                          <tr key={event}><td className="number-cell">{String(i + 1).padStart(2, "0")}</td><td>{event}</td><td className="font-mono text-xs">{i === 1 ? "pay_mello_001" : i === 3 ? "0x7c…92f1" : `EVT-${1703 + i}`}</td><td>{hasPayment ? <StatusBadge tone="green">完成</StatusBadge> : "待處理"}</td><td className="number-cell">{hasPayment ? `17:0${Math.min(4, 2 + i)}` : "—"}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-[#c3aa63] bg-[#fff7d9] px-4 py-2 text-xs text-[#5f522c]">SIMULATED SETTLEMENT / TESTNET FALLBACK — 本畫面不會移轉真實資金</div>
                </Panel>
              </div>

              <div className="min-w-0 space-y-5">
                <Panel id="section-4" code="B-01" title="政策檢核" meta="Hard rules">
                  <div className={`flex items-center justify-between border-b px-4 py-3 ${index < 2 ? "border-[#c6cbcd] bg-[#eceeea]" : allowed ? "border-[#7ea88a] bg-[#e5f1e8]" : "border-[#c98a84] bg-[#f8e7e5]"}`}>
                    <div><div className="text-[10px] text-[#63717a]">POLICY RESULT</div><b className="text-lg">{policyStatus}</b></div>
                    <StatusBadge tone={index < 2 ? "blue" : allowed ? "green" : "red"}>{policyStatus}</StatusBadge>
                  </div>
                  <div className="divide-y divide-[#d0d4d5]">
                    {[
                      ["Amount", `${budget} ≤ 0.10`, Number(budget) >= 0.05],
                      ["Approval", "0.05 ≤ 0.08", true],
                      ["Network / Asset", "Base Sepolia · USDC", true],
                      ["Seller", "TaiwanRisk · allowlisted", true],
                      ["payTo", stage === "mismatch" ? "ADDRESS_MISMATCH" : "Registry exact match", stage !== "mismatch"],
                      ["Invoice", "tw-einvoice", true],
                    ].map(([rule, detail, pass]) => <div key={String(rule)} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2.5 text-xs"><div><b>{rule}</b><span className="ml-2 text-[#68747d]">{detail}</span></div><b className={pass ? "text-[#35714a]" : "text-[#a64138]"}>{pass ? "PASS" : "FAIL"}</b></div>)}
                  </div>
                  {stage === "denied" && <div className="border-t border-[#c98a84] bg-[#fff0ee] px-4 py-3 text-xs font-bold text-[#963a32]">POLICY_DENIED · 無付款</div>}
                  {stage === "mismatch" && <div className="border-t border-[#c98a84] bg-[#fff0ee] px-4 py-3 text-xs font-bold text-[#963a32]">ADDRESS_MISMATCH · 無付款</div>}
                </Panel>

                <Panel id="section-5" code="B-02" title="三方對帳" meta="Payment / Service / Invoice">
                  <div className="divide-y divide-[#cbd0d1]">
                    <EvidenceRow label="付款" status={hasPayment ? "SETTLED" : "PENDING"} detail="0.05 USDC · pay_mello_001" active={hasPayment} />
                    <EvidenceRow label="服務" status={hasPayment ? "DELIVERED" : "PENDING"} detail="晨光貿易 · TR-12345678-0905" active={hasPayment} />
                    <EvidenceRow label="發票" status={isMatched ? "ISSUED_TEST" : "PENDING"} detail="青葉電子 53887711 · 風險管理部" active={isMatched} />
                  </div>
                  <div className="border-t border-[#c3aa63] bg-[#fff7d9] px-4 py-2 text-[11px] font-bold text-[#5f522c]">SANDBOX / TEST INVOICE — 非財政部有效發票</div>
                  <div className={`flex items-center justify-between border-t px-4 py-4 ${isMatched ? "border-[#7ea88a] bg-[#e5f1e8]" : "border-[#c8cdce] bg-[#eceeea]"}`}>
                    <span className="text-xs font-bold">RECONCILIATION</span>
                    <StatusBadge tone={isMatched ? "green" : "blue"}>{isMatched ? "MATCHED" : "PENDING"}</StatusBadge>
                  </div>
                </Panel>

                <Panel id="section-6" code="B-03" title="稽核事件" meta="Audit trail">
                  <div className="divide-y divide-[#cdd1d2]">
                    <AuditRow time="17:03" title="GlobalData 已拒絕" detail="無台灣發票／不在白名單" active={index >= 1} />
                    <AuditRow time="17:04" title="Payment / Service / Invoice" detail={isMatched ? "三方對帳 MATCHED" : "等待證據"} active={isMatched} />
                    <AuditRow time="17:06" title="財務 Agent 重複採購" detail={stage === "duplicate" ? "DUPLICATE_PURCHASE · 未付款" : "尚未執行"} active={stage === "duplicate"} />
                  </div>
                  <div className="space-y-2 border-t border-[#cbd0d1] p-4">
                    <button disabled={!isMatched} onClick={() => setStage("duplicate")} className="enterprise-button w-full text-left">模擬財務 Agent 重複下單</button>
                    <button onClick={() => setFrozen(!frozen)} className={`enterprise-button w-full text-left ${frozen ? "danger" : ""}`}>{frozen ? "付款已凍結 · 點擊解除" : "凍結所有新付款"}</button>
                  </div>
                </Panel>
              </div>
            </div>
          </div>

          <footer className="border-t border-[#b5bbbd] bg-[#dfe1de] px-6 py-2 text-[11px] text-[#647079]">Mello v0.1　｜　資料更新時間：2026/09/05 17:06　｜　環境：SANDBOX</footer>
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
  return <div className={`grid grid-cols-[42px_1fr] gap-3 px-4 py-3 ${active ? "opacity-100" : "opacity-55"}`}><span className="font-mono text-[10px] text-[#6f7a81]">{time}</span><div><b className="text-xs">{title}</b><div className="mt-1 text-[11px] text-[#6c777e]">{detail}</div></div></div>;
}
