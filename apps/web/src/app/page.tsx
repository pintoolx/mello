import Link from "next/link";
import { MelloLogo } from "@/components/mello-logo";

const workflow = [
  ["01", "Capture intent", "預算、用途、統編、成本中心與核准門檻成為結構化需求。"],
  ["02", "Enforce policy", "在付款前檢查供應商、payTo、網路、資產、發票能力與重複採購。"],
  ["03", "Authorize payment", "以同一 Payment ID 與 fingerprint 完成 x402 exact payment。"],
  ["04", "Close the books", "將付款、服務交付與發票紀錄對應到同一筆採購。"],
];

const controls = [
  ["Mandate", "Agent 可以買什麼、最多花多少，以及何時必須由人核准。"],
  ["Seller identity", "供應商白名單與收款地址完全綁定，避免目的地被替換。"],
  ["Invoice requirement", "要求台灣企業發票時，只允許宣告相容能力的服務。"],
  ["Duplicate prevention", "相同組織、服務與標的已有付款時，不產生第二筆交易。"],
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f3f0e7] text-[#1b2836]">
      <header className="border-b border-[#b1b7b6] bg-[#faf9f4] px-5 md:px-10">
        <nav className="mx-auto flex h-[76px] max-w-[1240px] items-center justify-between gap-6" aria-label="主要導覽">
          <MelloLogo light={false} />
          <div className="hidden items-center gap-8 text-sm font-semibold text-[#52616b] md:flex">
            <a href="#platform" className="hover:text-[#173a57]">產品</a>
            <a href="#workflow" className="hover:text-[#173a57]">運作方式</a>
            <a href="#governance" className="hover:text-[#173a57]">治理與證據</a>
          </div>
          <Link href="/app" className="enterprise-button primary">進入控制台</Link>
        </nav>
      </header>

      <section className="paper-grid border-b border-[#b1b7b6] px-5 py-20 md:px-10 md:py-28">
        <div className="mx-auto grid max-w-[1240px] gap-16 lg:grid-cols-[1.08fr_.92fr] lg:items-center">
          <div>
            <p className="section-code">AGENT PURCHASE-TO-PAY CONTROL</p>
            <h1 className="font-display mt-6 max-w-[760px] text-[clamp(3.25rem,6.4vw,6.4rem)] font-bold leading-[.96] tracking-[-.06em] text-[#172d42]">讓 Agent 付錢之後，帳還在。</h1>
            <p className="mt-7 text-xl font-semibold text-[#304654] md:text-2xl">x402 解決付款。Mello 把帳做完。</p>
            <p className="mt-5 max-w-[66ch] text-base leading-8 text-[#596871]">Mello 是企業採用 Agent 採購時的控制層。它把自然語言需求轉成可執行政策，在付款前守住權限，在付款後留下財務可以核對的完整紀錄。</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a href="#platform" className="enterprise-button primary min-h-11 px-6 py-3">了解 Mello</a>
              <Link href="/app" className="enterprise-button min-h-11 px-6 py-3">查看產品介面</Link>
            </div>
          </div>

          <ProductDiagram />
        </div>
      </section>

      <section id="platform" className="scroll-mt-8 border-b border-[#b1b7b6] bg-[#fbfaf5] px-5 py-20 md:px-10 md:py-24">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid gap-10 lg:grid-cols-[320px_1fr]">
            <div>
              <p className="section-code">THE CONTROL LAYER</p>
              <h2 className="font-display mt-4 text-4xl font-bold leading-[1.08] text-[#172d42] md:text-5xl">支付之外，企業還需要控制與記錄。</h2>
            </div>
            <div className="border-t-2 border-[#263f58]">
              {[
                ["01", "Intent becomes policy", "將聊天裡的預算、發票、核准與部門歸屬，變成系統真正執行的條件。"],
                ["02", "Payment becomes evidence", "把付款請求、收款地址、交易與重試指紋串進同一條可驗證的證據鏈。"],
                ["03", "Fulfillment becomes a record", "服務交付與發票資料必須對得上原始意圖，完成後才能關帳。"],
              ].map(([number, title, body]) => (
                <article key={number} className="grid gap-3 border-b border-[#bdc2c1] py-7 sm:grid-cols-[56px_220px_1fr]">
                  <span className="font-mono text-xs text-[#6b7880]">{number}</span>
                  <h3 className="font-bold text-[#253e52]">{title}</h3>
                  <p className="max-w-[60ch] text-sm leading-7 text-[#5d6a72]">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-8 border-b border-[#b1b7b6] bg-[#e5e7e3] px-5 py-20 md:px-10 md:py-24">
        <div className="mx-auto max-w-[1240px]">
          <div className="flex flex-col justify-between gap-5 border-b-2 border-[#263f58] pb-6 md:flex-row md:items-end">
            <div><p className="section-code">HOW IT WORKS</p><h2 className="font-display mt-4 text-4xl font-bold text-[#172d42] md:text-5xl">從採購意圖到財務紀錄。</h2></div>
            <p className="max-w-md text-sm leading-7 text-[#596871]">Agent 只提出建議；金額、權限、收款地址與重複付款由確定性的系統規則處理。</p>
          </div>
          <div className="grid border-x border-b border-[#aeb5b5] bg-[#f8f8f4] lg:grid-cols-4">
            {workflow.map(([number, title, body]) => (
              <article key={number} className="border-b border-[#bcc2c2] p-6 last:border-b-0 lg:min-h-72 lg:border-b-0 lg:border-r lg:last:border-r-0">
                <span className="font-mono text-xs text-[#657681]">{number}</span>
                <h3 className="mt-10 text-lg font-bold text-[#203a50]">{title}</h3>
                <p className="mt-4 text-sm leading-7 text-[#5d6a72]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="governance" className="scroll-mt-8 border-b border-[#b1b7b6] bg-[#fbfaf5] px-5 py-20 md:px-10 md:py-24">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid gap-12 lg:grid-cols-[.85fr_1.15fr]">
            <div>
              <p className="section-code">POLICY BEFORE PAYMENT</p>
              <h2 className="font-display mt-4 text-4xl font-bold leading-[1.08] text-[#172d42] md:text-5xl">讓自主採購仍然受企業規則約束。</h2>
              <p className="mt-6 max-w-[55ch] text-sm leading-7 text-[#5c6971]">Mello 不讓模型決定能不能付款。Agent 的輸出被限制為推薦與理由，最終授權交給可以稽核、可以重現的硬規則。</p>
            </div>
            <div className="border-t-2 border-[#263f58]">
              {controls.map(([title, body], index) => (
                <div key={title} className="grid gap-3 border-b border-[#bcc2c1] py-6 sm:grid-cols-[42px_180px_1fr]">
                  <span className="font-mono text-xs text-[#6c7880]">{String(index + 1).padStart(2, "0")}</span>
                  <h3 className="font-bold text-[#233e53]">{title}</h3>
                  <p className="text-sm leading-6 text-[#5c6971]">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#1f3a56] px-5 py-20 text-[#f4f3ec] md:px-10">
        <div className="mx-auto grid max-w-[1240px] gap-12 lg:grid-cols-[1fr_1fr] lg:items-end">
          <div>
            <p className="text-[10px] font-bold tracking-[.14em] text-[#aebec8]">BUILT FOR TAIWAN OPERATIONS</p>
            <h2 className="font-display mt-4 max-w-2xl text-4xl font-bold leading-[1.08] md:text-5xl">付款速度不必以失去會計脈絡為代價。</h2>
          </div>
          <div>
            <p className="max-w-[58ch] text-sm leading-7 text-[#d1d9dc]">Mello 保留統編、成本中心與發票能力等企業需要的欄位，並將它們一路帶進付款與對帳紀錄。團隊可以採用新的 Agent payment rail，而不必放棄原本的內控語言。</p>
            <Link href="/app" className="mt-7 inline-flex min-h-11 items-center border border-[#e6ecec] bg-[#f5f4ed] px-6 text-sm font-bold text-[#173149] hover:bg-white">進入產品控制台 →</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#a8afaf] bg-[#f8f7f1] px-5 py-8 md:px-10">
        <div className="mx-auto flex max-w-[1240px] flex-col justify-between gap-7 md:flex-row md:items-center">
          <MelloLogo light={false} />
          <p className="max-w-md text-xs leading-5 text-[#68747b]">Enterprise control and reconciliation for agent-initiated purchases.</p>
          <div className="text-xs text-[#68747b]">© 2026 Mello</div>
        </div>
      </footer>
    </main>
  );
}

function ProductDiagram() {
  return (
    <figure className="document-shadow border border-[#929c9f] bg-[#f9f8f2]" aria-label="Mello 系統架構示意">
      <div className="flex items-center justify-between border-b border-[#aeb5b5] bg-[#dfe2df] px-4 py-2.5 text-[10px] text-[#56646d]"><span>SYSTEM OVERVIEW</span><span>CONTROL / RECORD / RECONCILE</span></div>
      <div className="p-5 md:p-7">
        <div className="border border-[#9ca6aa] bg-[#eef0ec] px-4 py-3 text-center"><span className="text-[10px] text-[#68757d]">PURCHASE REQUEST</span><div className="mt-1 text-sm font-bold">Enterprise Agent</div></div>
        <div className="mx-auto h-7 w-px bg-[#829097]" />
        <div className="border-2 border-[#244660] bg-[#f8f8f3]">
          <div className="border-b border-[#9ca6aa] bg-[#1f3a56] px-4 py-3 text-center text-sm font-bold text-[#f2f3ee]">Mello Control Layer</div>
          <div className="grid grid-cols-3 gap-px bg-[#aeb5b5] text-center text-xs">
            <div className="bg-[#edf0ec] px-2 py-4"><span className="block text-[9px] text-[#718087]">01</span><b>Intent</b></div>
            <div className="bg-[#e4eee6] px-2 py-4"><span className="block text-[9px] text-[#527060]">02</span><b>Policy</b></div>
            <div className="bg-[#edf0ec] px-2 py-4"><span className="block text-[9px] text-[#718087]">03</span><b>Evidence</b></div>
          </div>
        </div>
        <div className="mx-auto h-7 w-px bg-[#829097]" />
        <div className="grid grid-cols-3 gap-px border border-[#9ca6aa] bg-[#9ca6aa] text-center">
          {["x402 payment", "Seller service", "Finance record"].map((item) => <div key={item} className="bg-[#eef0ec] px-2 py-4 text-[11px] font-semibold">{item}</div>)}
        </div>
      </div>
      <figcaption className="border-t border-[#aeb5b5] px-4 py-3 text-xs leading-5 text-[#64717a]">一個控制面，連接 Agent 的採購需求、付款協議與企業財務紀錄。</figcaption>
    </figure>
  );
}
