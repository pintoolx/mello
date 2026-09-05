"use client";

import { useState } from "react";
import { MelloLogo } from "./mello-logo";

type Stage = "idle" | "compare" | "policy" | "pay" | "matched" | "duplicate" | "denied" | "mismatch";

const promptDefault = "今天下午要決定能不能出貨給晨光貿易。幫我買一份企業信用風險報告，預算不超過 0.10 USDC。一定要能開台灣企業發票，統編開給青葉電子 53887711，費用記風險管理部。超過 0.08 USDC 先問我。";
const steps = [["17:02", "任務"], ["17:03", "比較"], ["17:03", "政策"], ["17:04", "付款"], ["17:04", "對帳"], ["17:06", "指揮中心"]];

export function MelloConsole() {
  const [stage, setStage] = useState<Stage>("idle");
  const [prompt, setPrompt] = useState(promptDefault);
  const [budget, setBudget] = useState("0.10");
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);

  const index = stage === "idle" ? 0 : stage === "compare" ? 1 : stage === "policy" || stage === "denied" || stage === "mismatch" ? 2 : stage === "pay" ? 3 : stage === "matched" ? 4 : 5;
  const allowed = !["denied", "mismatch"].includes(stage);
  const hasPayment = ["pay", "matched", "duplicate"].includes(stage);
  const isMatched = ["matched", "duplicate"].includes(stage);

  function run(next: Stage = Number(budget) < 0.05 ? "denied" : "matched") {
    setBusy(true);
    setStage("compare");
    window.setTimeout(() => setStage(next === "denied" || next === "mismatch" ? next : "policy"), 450);
    if (next !== "denied" && next !== "mismatch") {
      window.setTimeout(() => setStage("pay"), 900);
      window.setTimeout(() => { setStage(next); setBusy(false); }, 1400);
    } else window.setTimeout(() => setBusy(false), 650);
  }

  function reset() { setStage("idle"); setBudget("0.10"); setFrozen(false); setBusy(false); }

  return (
    <main className="scanline min-h-screen bg-[#111111] text-[#fafafa]">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#111111]/95 px-4 py-3 backdrop-blur md:px-8">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <MelloLogo />
          <div className="hidden items-center gap-3 md:flex">
            <span className="font-mono text-xs text-[#a8a8a8]">青葉電子 / 風險管理部</span>
            <span className="flex items-center gap-2 rounded-full bg-[#42f658]/10 px-3 py-2 text-xs font-semibold text-[#42f658]"><i className="h-2 w-2 rounded-full bg-[#42f658]" /> BASE SEPOLIA · SIMULATED</span>
          </div>
          <button onClick={reset} className="min-h-11 rounded-lg border border-white/20 px-4 text-sm font-semibold hover:bg-white/5">重置 Demo</button>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 md:px-8">
        <section className="mb-6 overflow-x-auto rounded-2xl border border-white/10 bg-[#171717] p-4">
          <div className="flex min-w-[900px] items-center">
            {steps.map(([time, label], i) => (
              <div key={label} className="flex flex-1 items-center">
                <div className="flex items-center gap-3">
                  <span className={`grid h-9 w-9 place-items-center rounded-full border text-sm font-bold ${i <= index ? "border-[#42f658] bg-[#42f658] text-[#111]" : "border-white/20 text-[#545454]"}`}>{i < index ? "✓" : i + 1}</span>
                  <div><div className={`font-mono text-[11px] ${i <= index ? "text-[#8cf699]" : "text-[#545454]"}`}>{time}</div><div className={`font-semibold ${i <= index ? "text-white" : "text-[#787878]"}`}>{label}</div></div>
                </div>
                {i < steps.length - 1 && <span className={`mx-4 h-px flex-1 ${i < index ? "bg-[#42f658]" : "bg-white/10"}`} />}
              </div>
            ))}
          </div>
        </section>

        <div className="mb-6 flex flex-col justify-between gap-4 border-l-4 border-[#42f658] bg-[#171717] p-5 lg:flex-row lg:items-center">
          <div><div className="font-mono text-xs font-semibold tracking-[.12em] text-[#8cf699]">SHIPMENT DECISION / TODAY 17:00</div><h1 className="mt-2 text-3xl font-extrabold tracking-[-.04em] md:text-5xl">晨光貿易，第一批貨能不能出？</h1></div>
          <div className="shrink-0 text-left lg:text-right"><div className="text-sm text-[#a8a8a8]">距回覆期限</div><div className="font-mono text-3xl font-bold text-[#42f658]">00:06:00</div></div>
        </div>

        <Section number="01" title="Task Composer" meta="林佳穎 · 風險">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-40 w-full resize-none rounded-xl border border-white/15 bg-[#0d0d0d] p-5 text-lg leading-8 text-white outline-none focus:border-[#42f658]" aria-label="採購任務" />
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip label="預算" value={`${budget} USDC`} active />
            <Chip label="統編" value="53887711" />
            <Chip label="成本中心" value="風險管理部" />
            <Chip label="自動門檻" value="0.08 USDC" />
            <Chip label="發票" value="必備" />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button disabled={busy || frozen} onClick={() => run()} className="min-h-14 rounded-xl bg-[#42f658] px-7 text-lg font-extrabold text-[#111] hover:bg-[#8cf699] disabled:cursor-not-allowed disabled:bg-[#545454]">{busy ? "Agent 執行中…" : frozen ? "新付款已凍結" : "執行採購任務 →"}</button>
            <button onClick={() => { setBudget("0.03"); run("denied"); }} className="min-h-11 rounded-lg border border-white/15 px-4 text-sm text-[#a8a8a8] hover:border-white/30">測試 0.03 預算</button>
            <button onClick={() => run("mismatch")} className="min-h-11 rounded-lg border border-white/15 px-4 text-sm text-[#a8a8a8] hover:border-white/30">測試 payTo 不符</button>
          </div>
        </Section>

        <Section number="02" title="Decision" meta="固定 Registry · 2 sellers">
          <div className="grid gap-4 lg:grid-cols-2">
            <SellerCard tone="red" name="GlobalData API" price="0.04" kicker="不能出貨用" tags={["無台灣發票", "不在白名單"]} selected={index >= 1} />
            <SellerCard tone="green" name="TaiwanRisk API" price="0.05" kicker="可以回覆業務" tags={["tw-einvoice", "payTo 已綁定"]} selected={index >= 1} />
          </div>
          <div className="mt-4 grid gap-px overflow-hidden rounded-xl bg-white/10 md:grid-cols-4">
            {["recommendedAction / PURCHASE", "selectedServiceId / taiwanrisk", "reasonCodes / 3", "confidence / 0.99"].map((item) => <div key={item} className="bg-[#141414] p-4 font-mono text-xs text-[#a8a8a8]">{item}</div>)}
          </div>
        </Section>

        <Section number="03" title="Policy" meta="Hard rules · 非 LLM 決策">
          <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
            <div className="overflow-hidden rounded-xl border border-white/10">
              {[
                ["Amount", `${budget} ≤ 0.10 mandate`, Number(budget) >= 0.05],
                ["Approval", "0.05 ≤ 0.08 threshold", true],
                ["Network / Asset", "Base Sepolia · USDC", true],
                ["Seller", "TaiwanRisk · allowlisted", true],
                ["payTo", stage === "mismatch" ? "ADDRESS_MISMATCH" : "Registry exact match", stage !== "mismatch"],
                ["Invoice", "tw-einvoice capability", true],
              ].map(([rule, detail, pass]) => <div key={String(rule)} className="grid grid-cols-[110px_1fr_auto] items-center gap-4 border-b border-white/10 px-4 py-3 last:border-0"><b>{rule}</b><span className="text-sm text-[#a8a8a8]">{detail}</span><span className={`font-mono text-xs font-bold ${pass ? "text-[#42f658]" : "text-[#ff665e]"}`}>{pass ? "PASS" : "FAIL"}</span></div>)}
            </div>
            <div className={`grid min-h-64 place-items-center rounded-xl border-2 p-6 text-center ${index < 2 ? "border-white/10 text-[#545454]" : allowed ? "border-[#42f658] bg-[#42f658]/5 text-[#42f658]" : "border-[#ff665e] bg-[#ff665e]/5 text-[#ff665e]"}`}>
              <div><div className="font-mono text-xs tracking-[.16em]">POLICY ENGINE</div><div className="mt-3 text-5xl font-extrabold tracking-[-.06em]">{index < 2 ? "WAITING" : allowed ? "ALLOW" : "DENY"}</div>{stage === "denied" && <div className="mt-4 text-sm">POLICY_DENIED · 無付款</div>}{stage === "mismatch" && <div className="mt-4 text-sm">ADDRESS_MISMATCH · 無付款</div>}</div>
            </div>
          </div>
        </Section>

        <Section number="04" title="Payment Timeline" meta="x402 exact · same logical payment ID">
          <div className="relative grid gap-3 md:grid-cols-5">
            {["402", "pay_mello_001", "verify", "tx", "receipt"].map((item, i) => <div key={item} className={`relative rounded-xl border p-5 ${hasPayment ? "border-[#76daa1]/50 bg-[#76daa1]/5" : "border-white/10 bg-[#141414]"}`}><div className={`mb-8 h-2 w-2 rounded-full ${hasPayment ? "bg-[#42f658]" : "bg-[#545454]"}`} /><div className="font-mono text-sm font-bold">{item}</div><div className="mt-2 text-xs text-[#787878]">{i === 0 ? "payment required" : i === 1 ? "fingerprint locked" : i === 2 ? "facilitator" : i === 3 ? "Base Sepolia" : "settled"}</div></div>)}
          </div>
          <div className="mt-4 flex items-center justify-between rounded-lg bg-[#252017] px-4 py-3 text-sm text-[#ffbd59]"><span>⚠ SIMULATED SETTLEMENT — 現場無鏈上資金風險</span><span className="font-mono">TESTNET FALLBACK</span></div>
        </Section>

        <Section number="05" title="Invoice & Reconcile" meta="Three-way match">
          <div className="grid gap-px overflow-hidden rounded-xl bg-white/10 lg:grid-cols-3">
            <Evidence title="Payment" value={hasPayment ? "SETTLED" : "PENDING"} lines={["0.05 USDC", "pay_mello_001"]} active={hasPayment} />
            <Evidence title="Service" value={hasPayment ? "DELIVERED" : "PENDING"} lines={["晨光貿易 12345678", "TR-12345678-0905"]} active={hasPayment} />
            <Evidence title="Invoice" value={isMatched ? "ISSUED_TEST" : "PENDING"} lines={["青葉電子 53887711", "風險管理部"]} active={isMatched} />
          </div>
          <div className="mt-4 bg-[#ffbd59] px-5 py-3 text-center font-mono text-sm font-bold tracking-[.12em] text-[#111]">SANDBOX / TEST INVOICE — 非財政部有效發票</div>
          <div className={`mt-4 rounded-xl border-2 py-10 text-center ${isMatched ? "border-[#42f658] bg-[#42f658] text-[#111]" : "border-white/10 text-[#545454]"}`}><div className="font-mono text-xs tracking-[.2em]">RECONCILIATION</div><div className="mt-2 text-6xl font-extrabold tracking-[-.07em] md:text-8xl">{isMatched ? "MATCHED" : "PENDING"}</div></div>
        </Section>

        <Section number="06" title="Command Center" meta="Evidence chain">
          <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
            <div className="overflow-hidden rounded-xl border border-white/10">
              <AuditRow time="17:03" title="GlobalData 已拒絕" detail="無台灣發票 · 不在白名單" tone="red" active={index >= 1} />
              <AuditRow time="17:04" title="Payment / Service / Invoice" detail={isMatched ? "三方對帳 MATCHED" : "等待證據"} tone="green" active={isMatched} />
              <AuditRow time="17:06" title="財務 Agent 重複採購" detail={stage === "duplicate" ? "DUPLICATE_PURCHASE · 未付款" : "點擊測試重複單"} tone="amber" active={stage === "duplicate"} />
            </div>
            <div className="space-y-3">
              <button disabled={!isMatched} onClick={() => setStage("duplicate")} className="min-h-14 w-full rounded-xl border border-[#ffbd59] px-5 text-left font-bold text-[#ffbd59] hover:bg-[#ffbd59]/10 disabled:border-white/10 disabled:text-[#545454]">模擬財務 Agent 重複下單</button>
              <button onClick={() => setFrozen(!frozen)} className={`min-h-14 w-full rounded-xl px-5 text-left font-bold ${frozen ? "bg-[#ff665e] text-[#111]" : "border border-white/20"}`}>{frozen ? "付款已凍結 · 點擊解除" : "凍結所有新付款"}</button>
            </div>
          </div>
        </Section>
      </div>
    </main>
  );
}

function Section({ number, title, meta, children }: { number: string; title: string; meta: string; children: React.ReactNode }) {
  return <section className="mb-6 rounded-2xl border border-white/10 bg-[#171717] p-5 md:p-7"><header className="mb-6 flex items-end justify-between gap-4 border-b border-white/10 pb-4"><div className="flex items-baseline gap-3"><span className="font-mono text-xs text-[#42f658]">{number}</span><h2 className="text-2xl font-extrabold tracking-[-.03em] md:text-3xl">{title}</h2></div><span className="hidden font-mono text-xs text-[#787878] sm:block">{meta}</span></header>{children}</section>;
}
function Chip({ label, value, active = false }: { label: string; value: string; active?: boolean }) { return <span className={`rounded-full border px-3 py-2 text-sm ${active ? "border-[#42f658]/60 bg-[#42f658]/10" : "border-white/15"}`}><span className="text-[#787878]">{label}</span> <b className={active ? "text-[#42f658]" : "text-white"}>{value}</b></span>; }
function SellerCard({ tone, name, price, kicker, tags, selected }: { tone: "red" | "green"; name: string; price: string; kicker: string; tags: string[]; selected: boolean }) { const green = tone === "green"; return <article className={`relative overflow-hidden rounded-xl border-2 p-6 ${selected ? green ? "border-[#42f658]" : "border-[#ff665e] opacity-70" : "border-white/10"}`}><div className={`absolute right-0 top-0 px-4 py-2 text-xs font-bold ${green ? "bg-[#42f658] text-[#111]" : "bg-[#ff665e] text-[#111]"}`}>{selected ? green ? "SELECTED" : "REJECTED" : "CANDIDATE"}</div><div className={`text-sm font-bold ${green ? "text-[#42f658]" : "text-[#ff665e]"}`}>{kicker}</div><h3 className="mt-2 text-2xl font-extrabold">{name}</h3><div className="mt-7 flex items-end gap-2"><b className="font-mono text-5xl">{price}</b><span className="pb-2 text-[#a8a8a8]">USDC</span></div><div className="mt-5 flex flex-wrap gap-2">{tags.map((tag) => <span key={tag} className="rounded-full border border-white/15 px-3 py-1 text-xs text-[#a8a8a8]">{tag}</span>)}</div></article>; }
function Evidence({ title, value, lines, active }: { title: string; value: string; lines: string[]; active: boolean }) { return <article className="bg-[#141414] p-6"><div className="font-mono text-xs text-[#787878]">{title.toUpperCase()}</div><div className={`mt-5 text-2xl font-extrabold ${active ? "text-[#42f658]" : "text-[#545454]"}`}>{value}</div><div className="mt-8 space-y-2 text-sm text-[#a8a8a8]">{lines.map((line) => <div key={line}>{line}</div>)}</div></article>; }
function AuditRow({ time, title, detail, tone, active }: { time: string; title: string; detail: string; tone: "red" | "green" | "amber"; active: boolean }) { const color = tone === "red" ? "#ff665e" : tone === "green" ? "#42f658" : "#ffbd59"; return <div className={`grid grid-cols-[60px_1fr_auto] items-center gap-4 border-b border-white/10 p-4 last:border-0 ${active ? "opacity-100" : "opacity-35"}`}><span className="font-mono text-xs text-[#787878]">{time}</span><div><b>{title}</b><div className="mt-1 text-sm text-[#a8a8a8]">{detail}</div></div><span className="h-3 w-3 rounded-full" style={{ background: active ? color : "#545454" }} /></div>; }

