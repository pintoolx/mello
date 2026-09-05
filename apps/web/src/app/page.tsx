import Link from "next/link";
import { MelloLogo } from "@/components/mello-logo";

const loop = ["Intent", "Policy", "x402 Payment", "Service", "Test Invoice", "Reconcile"];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#080b0e] text-[#f2efe6]">
      <section className="hairline-grid relative min-h-[92vh] border-b border-[#27323b] px-5 py-6 md:px-10 lg:px-16">
        <nav className="mx-auto flex max-w-[1440px] items-center justify-between border-b border-[#27323b] pb-5">
          <MelloLogo />
          <div className="hidden font-mono text-xs text-[#93a0a9] sm:block">P2P CONTROL / TAIWAN</div>
        </nav>
        <div className="mx-auto grid max-w-[1440px] gap-14 pb-14 pt-20 lg:grid-cols-[1.25fr_.75fr] lg:items-end lg:pt-32">
          <div>
            <div className="mb-7 inline-flex items-center gap-3 rounded-full border border-[#545454] bg-[#111111] px-4 py-2 font-mono text-xs tracking-[.12em] text-[#42f658]">
              <span className="h-2 w-2 rounded-full bg-[#42f658]" /> AGENT PURCHASE CONTROL
            </div>
            <h1 className="font-display max-w-5xl text-[clamp(3.1rem,7vw,6.5rem)] font-medium leading-[.92] tracking-[-.065em]">
              <span className="block whitespace-nowrap">讓 Agent 付錢</span>
              <span className="block whitespace-nowrap">之後，<span className="text-[#42f658]">帳還在。</span></span>
            </h1>
            <p className="mt-8 text-xl font-semibold tracking-[-.02em] text-[#bcc4c9] md:text-3xl">x402 解決付款。Mello 把帳做完。</p>
          </div>
          <aside className="border-l-4 border-[#ffbd59] bg-[#111820] p-6 lg:mb-3">
            <div className="font-mono text-xs tracking-[.15em] text-[#ffbd59]">LIVE DEMO / 17:00 DEADLINE</div>
            <p className="mt-5 text-xl font-bold leading-relaxed">青葉電子必須在今天 17:00 回覆：晨光貿易能不能出第一批貨。</p>
            <Link href="/app" className="mt-8 flex min-h-14 items-center justify-between rounded-xl bg-[#42f658] px-5 font-bold text-[#111111] transition hover:bg-[#8cf699]">
              開啟操作台 <span aria-hidden>→</span>
            </Link>
          </aside>
        </div>
      </section>

      <section id="controls" className="mx-auto max-w-[1440px] scroll-mt-8 px-5 py-24 md:px-10 lg:px-16">
        <p className="font-mono text-xs tracking-[.18em] text-[#ffbd59]">01 / WHAT MELLO CONTROLS</p>
        <div className="mt-8 grid border-l border-t border-[#27323b] md:grid-cols-3">
          {[
            ["意圖變成規則", "預算、統編、成本中心、核准門檻，不留在對話裡。"],
            ["付款留下證據", "payTo 綁定、fingerprint、x402 receipt 串成同一條鏈。"],
            ["交付完成對帳", "Payment、Service、Test Invoice 三方一致才算完成。"],
          ].map(([title, body], i) => (
            <article key={title} className="min-h-64 border-b border-r border-[#27323b] p-7">
              <div className="font-display text-5xl text-[#33404a]">0{i + 1}</div>
              <h2 className="mt-10 text-2xl font-extrabold">{title}</h2>
              <p className="mt-4 max-w-sm leading-7 text-[#93a0a9]">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="loop" className="scroll-mt-8 border-y border-[#27323b] bg-[#0d1217] px-5 py-24 md:px-10 lg:px-16">
        <div className="mx-auto max-w-[1440px]">
          <p className="font-mono text-xs tracking-[.18em] text-[#ffbd59]">02 / THE CLOSED LOOP</p>
          <h2 className="font-display mt-5 text-4xl font-extrabold tracking-[-.04em] md:text-6xl">一筆付款，六段證據。</h2>
          <div className="mt-12 grid gap-px bg-[#27323b] sm:grid-cols-2 lg:grid-cols-6">
            {loop.map((item, i) => (
              <div key={item} className="relative min-h-40 bg-[#0d1217] p-5">
                <div className="font-mono text-xs text-[#61707a]">{String(i + 1).padStart(2, "0")}</div>
                <div className="mt-14 font-bold">{item}</div>
                {i < loop.length - 1 && <span className="absolute -right-3 top-1/2 z-10 hidden h-6 w-6 place-items-center rounded-full bg-[#42f658] font-mono text-[#111111] lg:grid">→</span>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="scenario" className="mx-auto grid max-w-[1440px] scroll-mt-8 gap-16 px-5 py-24 md:px-10 lg:grid-cols-2 lg:px-16">
        <div>
          <p className="font-mono text-xs tracking-[.18em] text-[#ffbd59]">03 / 17:00 SCENARIO</p>
          <h2 className="font-display mt-5 text-4xl font-extrabold tracking-[-.04em] md:text-6xl">六分鐘內，帳跟決策一起完成。</h2>
        </div>
        <ol className="border-l border-[#46535d]">
          {[
            ["17:02", "林佳穎下達採購意圖"],
            ["17:03", "拒絕 GlobalData，選擇 TaiwanRisk"],
            ["17:04", "政策通過、x402 付款、三方對帳"],
            ["17:06", "證據鏈進入指揮中心"],
          ].map(([time, copy]) => (
            <li key={time} className="relative border-b border-[#27323b] py-6 pl-8">
              <span className="absolute -left-[5px] top-8 h-[9px] w-[9px] rounded-full bg-[#42f658]" />
              <span className="font-mono text-sm text-[#42f658]">{time}</span>
              <div className="mt-2 text-xl font-bold">{copy}</div>
            </li>
          ))}
        </ol>
      </section>

      <section id="scope" className="scroll-mt-8 border-t border-[#27323b] px-5 py-24 md:px-10 lg:px-16">
        <div className="mx-auto grid max-w-[1440px] gap-px bg-[#27323b] lg:grid-cols-2">
          <article className="bg-[#111820] p-8"><div className="font-mono text-xs text-[#42f658]">MELLO DOES</div><h3 className="mt-5 text-3xl font-extrabold">控制、留證、對帳</h3><p className="mt-4 leading-7 text-[#93a0a9]">把 Agent 的採購意圖變成可驗證的政策與會計證據。</p></article>
          <article className="bg-[#111820] p-8"><div className="font-mono text-xs text-[#ff665e]">MELLO DOES NOT</div><h3 className="mt-5 text-3xl font-extrabold">不做市集、不代管資金</h3><p className="mt-4 leading-7 text-[#93a0a9]">不自架 facilitator、不處理正式電子發票、不碰主網資產。</p></article>
        </div>
        <div className="mx-auto mt-16 flex max-w-[1440px] flex-col justify-between gap-8 border-t border-[#27323b] pt-8 md:flex-row md:items-center">
          <MelloLogo />
          <Link href="/app" className="rounded-xl bg-[#fafafa] px-8 py-4 text-center font-bold text-[#111111] hover:bg-white">進入 17:00 Demo →</Link>
        </div>
      </section>
    </main>
  );
}
