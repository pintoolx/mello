import Link from "next/link";
import { MelloLogo } from "@/components/mello-logo";

const workflow = [
  ["01", "Intent", "將自然語言需求整理為金額、用途、統編、成本中心與核准門檻。"],
  ["02", "Policy", "以硬規則檢查白名單、payTo、發票能力、網路與重複採購。"],
  ["03", "Payment", "沿用同一 Payment ID 與 fingerprint 完成 x402 付款驗證。"],
  ["04", "Service", "保存服務交付憑證，對應原始採購標的與訂單。"],
  ["05", "Invoice", "建立 sandbox 發票工作，保留買受人與成本歸屬。"],
  ["06", "Reconcile", "Payment、Service、Invoice 三方一致才標記完成。"],
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f3f0e7] text-[#1b2836]">
      <div className="bg-[#1f3a56] px-5 py-2 text-[10px] tracking-[.13em] text-[#edf1f2] md:px-10">
        MELLO　/　AGENT PURCHASE-TO-PAY CONTROL　/　TAIWAN
      </div>

      <header className="border-b border-[#aeb5b5] bg-[#faf9f4] px-5 py-4 md:px-10">
        <nav className="mx-auto flex max-w-[1240px] items-center justify-between gap-6" aria-label="主要導覽">
          <MelloLogo light={false} />
          <div className="hidden items-center gap-7 text-xs font-semibold text-[#50606b] md:flex">
            <a href="#product" className="hover:text-[#183b5b]">產品說明</a>
            <a href="#workflow" className="hover:text-[#183b5b]">處理流程</a>
            <a href="#scenario" className="hover:text-[#183b5b]">實際情境</a>
          </div>
          <Link href="/app" className="enterprise-button primary">開啟產品介面</Link>
        </nav>
      </header>

      <section className="paper-grid border-b border-[#aeb5b5] px-5 py-14 md:px-10 md:py-20">
        <div className="mx-auto grid max-w-[1240px] gap-12 lg:grid-cols-[.9fr_1.1fr] lg:items-center">
          <div>
            <div className="inline-flex border border-[#789383] bg-[#e5eee7] px-3 py-1.5 text-[10px] font-bold tracking-[.12em] text-[#345d41]">企業 Agent 採購控制層</div>
            <h1 className="font-display mt-7 max-w-[680px] text-[clamp(2.8rem,5.5vw,5.4rem)] font-bold leading-[1.02] tracking-[-.055em] text-[#172d42]">
              讓 Agent 付錢之後，帳還在。
            </h1>
            <p className="mt-6 max-w-xl text-lg font-semibold leading-8 text-[#354956] md:text-xl">x402 解決付款。Mello 把帳做完。</p>
            <p className="mt-4 max-w-[62ch] text-sm leading-7 text-[#5d6b73]">Mello 將 Agent 的採購意圖轉成企業可執行的政策，在付款完成後留下服務、發票與對帳證據。財務不需要重新猜測一筆鏈上付款是誰花的、為什麼花、該記到哪裡。</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/app" className="enterprise-button primary min-h-10 px-5 py-2.5">檢視操作介面</Link>
              <a href="#product" className="enterprise-button min-h-10 px-5 py-2.5">閱讀產品說明</a>
            </div>
            <dl className="mt-10 grid max-w-xl grid-cols-3 border-y border-[#aeb5b5] py-4 text-xs">
              <div><dt className="text-[#6b777e]">政策方式</dt><dd className="mt-1 font-bold">硬規則</dd></div>
              <div><dt className="text-[#6b777e]">付款協議</dt><dd className="mt-1 font-bold">x402 exact</dd></div>
              <div><dt className="text-[#6b777e]">對帳結果</dt><dd className="mt-1 font-bold">三方一致</dd></div>
            </dl>
          </div>

          <figure className="document-shadow border border-[#8f999f] bg-[#f9f9f5]">
            <div className="flex items-center justify-between border-b border-[#aeb5b5] bg-[#dfe2df] px-4 py-2 text-[10px] text-[#54616a]">
              <span>產品操作紀錄　/　採購案件 PI-20260905-017</span>
              <span>00:12</span>
            </div>
            <div className="bg-[#cdd1cf] p-2 md:p-3">
              <video className="aspect-video w-full border border-[#8f999f] bg-[#e7e8e4] object-cover" aria-label="Mello 採購與對帳操作紀錄" autoPlay controls loop muted playsInline preload="metadata" poster="/demo/mello-workflow-poster.png">
                <source src="/demo/mello-workflow.mp4" type="video/mp4" />
                您的瀏覽器不支援影片播放。
              </video>
            </div>
            <figcaption className="grid gap-px border-t border-[#aeb5b5] bg-[#b7bdbe] text-xs sm:grid-cols-3">
              <div className="bg-[#f2f2ed] px-3 py-3"><span className="block text-[9px] text-[#758087]">流程 01</span><b>輸入採購需求</b></div>
              <div className="bg-[#f2f2ed] px-3 py-3"><span className="block text-[9px] text-[#758087]">流程 02</span><b>政策自動檢核</b></div>
              <div className="bg-[#f2f2ed] px-3 py-3"><span className="block text-[9px] text-[#758087]">流程 03</span><b>付款完成對帳</b></div>
            </figcaption>
          </figure>
        </div>
      </section>

      <section id="product" className="scroll-mt-8 border-b border-[#aeb5b5] bg-[#fbfaf5] px-5 py-16 md:px-10 md:py-20">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
            <div>
              <div className="section-code">01　產品職責</div>
              <h2 className="font-display mt-4 text-4xl font-bold leading-tight text-[#172d42]">付款只是流程中間，不是結束。</h2>
            </div>
            <div className="border-t-2 border-[#263f58]">
              {[
                ["採購意圖", "預算、核准門檻、成本中心與發票要求先成為結構化紀錄。", "INTENT REGISTERED"],
                ["付款控制", "供應商白名單、payTo 綁定與重複採購在付款前完成檢查。", "POLICY ENFORCED"],
                ["會計證據", "付款、服務交付與測試發票對應到同一筆案件。", "RECORD RECONCILED"],
              ].map(([title, body, status], i) => (
                <article key={title} className="grid gap-3 border-b border-[#bcc2c2] py-6 md:grid-cols-[54px_160px_1fr_150px] md:items-start">
                  <span className="font-mono text-xs text-[#6d7a81]">0{i + 1}</span>
                  <h3 className="font-bold text-[#233d52]">{title}</h3>
                  <p className="text-sm leading-6 text-[#5c6971]">{body}</p>
                  <span className="justify-self-start border border-[#82a08b] bg-[#e5eee7] px-2 py-1 text-[9px] font-bold text-[#365f43]">{status}</span>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="workflow" className="scroll-mt-8 border-b border-[#aeb5b5] bg-[#e7e8e4] px-5 py-16 md:px-10 md:py-20">
        <div className="mx-auto max-w-[1240px]">
          <div className="flex flex-col justify-between gap-4 border-b-2 border-[#263f58] pb-5 md:flex-row md:items-end">
            <div><div className="section-code">02　處理流程</div><h2 className="font-display mt-3 text-4xl font-bold text-[#172d42]">六段紀錄，對應一筆採購。</h2></div>
            <p className="max-w-md text-sm leading-6 text-[#5b6870]">每一段都有明確輸入與結果；Agent 提建議，政策引擎做最終決定。</p>
          </div>
          <div className="overflow-x-auto border-x border-b border-[#aeb5b5] bg-[#f8f8f4]">
            <table className="enterprise-table min-w-[800px]">
              <thead><tr><th>順序</th><th>處理階段</th><th>系統留下的紀錄</th><th>責任邊界</th></tr></thead>
              <tbody>{workflow.map(([number, title, description]) => <tr key={number}><td className="number-cell">{number}</td><td><b>{title}</b></td><td>{description}</td><td>{number === "02" ? "Policy Engine" : number === "03" ? "x402" : "Mello"}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="scenario" className="scroll-mt-8 border-b border-[#aeb5b5] bg-[#fbfaf5] px-5 py-16 md:px-10 md:py-20">
        <div className="mx-auto grid max-w-[1240px] gap-10 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <div className="section-code">03　實際情境</div>
            <h2 className="font-display mt-4 text-4xl font-bold leading-tight text-[#172d42]">青葉電子必須在 17:00 前決定是否出貨。</h2>
            <p className="mt-5 text-sm leading-7 text-[#5c6971]">風險人員要求 Agent 購買晨光貿易的企業信用報告。Mello 拒絕較便宜但不符合發票與白名單要求的供應商，選擇可留下完整憑證的服務。</p>
          </div>
          <div className="document-shadow border border-[#949da2] bg-[#f5f2e9]">
            <div className="flex justify-between border-b-2 border-[#263f58] px-5 py-3 text-xs"><b>案件處理紀錄</b><span className="font-mono">2026/09/05</span></div>
            {[
              ["17:02", "採購意圖受理", "預算 0.10 USDC／發票必備／風險管理部"],
              ["17:03", "供應商決策", "拒絕 GlobalData；選用 TaiwanRisk 0.05 USDC"],
              ["17:04", "付款與對帳", "Policy ALLOW／SETTLED／ISSUED_TEST／MATCHED"],
              ["17:06", "重複採購攔截", "同標的第二筆需求標記 DUPLICATE_PURCHASE"],
            ].map(([time, title, detail]) => <div key={time} className="grid gap-2 border-b border-[#bfc4c3] px-5 py-4 last:border-b-0 sm:grid-cols-[70px_150px_1fr]"><span className="font-mono text-xs text-[#345873]">{time}</span><b className="text-sm">{title}</b><span className="text-xs leading-5 text-[#626f76]">{detail}</span></div>)}
          </div>
        </div>
      </section>

      <section className="bg-[#dfe2df] px-5 py-14 md:px-10">
        <div className="mx-auto grid max-w-[1240px] gap-8 md:grid-cols-2">
          <div className="border-t-2 border-[#3f7751] pt-5"><div className="section-code text-[#3f7751]">MELLO DOES</div><h3 className="mt-3 text-xl font-bold">控制、留證、對帳</h3><p className="mt-3 text-sm leading-6 text-[#5d6970]">把 Agent 的採購意圖變成可稽核的政策、付款與會計紀錄。</p></div>
          <div className="border-t-2 border-[#8e4a42] pt-5"><div className="section-code text-[#8e4a42]">MELLO DOES NOT</div><h3 className="mt-3 text-xl font-bold">不做市集、不代管資金</h3><p className="mt-3 text-sm leading-6 text-[#5d6970]">不自架 facilitator、不處理正式電子發票、不碰主網資產。</p></div>
        </div>
      </section>

      <footer className="border-t border-[#9fa7a9] bg-[#f8f7f1] px-5 py-8 md:px-10">
        <div className="mx-auto flex max-w-[1240px] flex-col justify-between gap-6 md:flex-row md:items-center">
          <MelloLogo light={false} />
          <div className="text-xs leading-5 text-[#68747b]">Agent Purchase-to-Pay Control<br />SANDBOX PRODUCT DEMONSTRATION</div>
          <Link href="/app" className="enterprise-button primary">開啟產品介面 →</Link>
        </div>
      </footer>
    </main>
  );
}
