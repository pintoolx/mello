import type { ReactNode } from "react";

export type Document = {
  slug: string;
  group: string;
  title: string;
  description: string;
  sections: { id: string; title: string; content: ReactNode }[];
};

export const documents: Document[] = [
  {
    slug: "",
    group: "開始閱讀",
    title: "認識 Mello",
    description:
      "企業把採購交給 Agent 之後，仍然需要控制支出，並保留能核對的帳。",
    sections: [
      {
        id: "purpose",
        title: "Mello 解決什麼問題",
        content: (
          <>
            <p>
              付款成功，不代表企業完成了一筆採購。財務仍需要知道買了什麼、為何選用這家供應商、誰的預算被使用，以及收到的服務與發票是否和付款一致。
            </p>
            <p>
              Mello 是企業的 Agent Purchase-to-Pay
              控制層：接收採購需求，以確定性政策約束執行，再把付款、交付、測試發票及對帳結果保存在同一個案件。
            </p>
            <blockquote>x402 解決付款。Mello 把帳做完。</blockquote>
          </>
        ),
      },
      {
        id: "roles",
        title: "誰會使用",
        content: (
          <div className="doc-table">
            <table>
              <thead>
                <tr>
                  <th>角色</th>
                  <th>工作</th>
                  <th>留下的結果</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>需求部門</td>
                  <td>提出查詢標的、預算與用途</td>
                  <td>可追溯的採購申請</td>
                </tr>
                <tr>
                  <td>採購 Agent</td>
                  <td>解析需求，觸發供應商評估與執行</td>
                  <td>選用依據與處理紀錄</td>
                </tr>
                <tr>
                  <td>財務人員</td>
                  <td>核對付款、服務交付與發票</td>
                  <td>對帳結果與異常處理依據</td>
                </tr>
              </tbody>
            </table>
          </div>
        ),
      },
      {
        id: "boundaries",
        title: "責任邊界",
        content: (
          <>
            <p>
              Mello 不建立 marketplace，不自架
              facilitator，也不提供主網資金保管或正式電子發票服務。供應商由既有
              Registry 定義，付款協議使用 x402，發票目前透過測試 Adapter 協調。
            </p>
            <div className="doc-note">
              <strong>目前版本</strong>
              <p>
                產品已具備可保存的採購流程。AI
                解析、付款與歸檔模式由後端環境決定；模擬結算與測試發票不是正式資金或會計憑證。
              </p>
            </div>
          </>
        ),
      },
      {
        id: "reading",
        title: "如何閱讀這份文件",
        content: (
          <>
            <p>
              先從「採購操作」了解一筆案件的生命週期，再閱讀「政策與授權」及「付款、發票與對帳」。工程整合請看「系統架構」，能力邊界以「實作範圍」為準。
            </p>
            <p>
              本文件站是獨立的靜態說明，不讀取案件或付款資料，也不提供交易操作。
            </p>
          </>
        ),
      },
    ],
  },
  {
    slug: "purchase-guide",
    group: "使用指南",
    title: "採購操作",
    description: "從建立需求到查看憑證，每一筆申請都保留獨立案件編號。",
    sections: [
      {
        id: "create",
        title: "建立採購申請",
        content: (
          <>
            <p>
              在「採購申請」選擇「新增採購申請」。在同一個需求區描述想找的服務，並可附上相關文件；不必指定企業。可搜尋個股分析、總經分析、加密市場資訊或期貨分析，每筆申請選用一項服務。
            </p>
            <p>
              預算、發票與認證條件分別設定，公司抬頭、統一編號與成本中心沿用公司設定。建立後會自動尋找服務，但不會立即付款。附件先隨案件保存，目前搜尋依據是文字需求。
            </p>
            <div className="doc-example">
              <span>需求範例</span>
              <p>
                需求：總經分析，關注亞洲市場利率與通膨
                <br />
                預算上限：0.10 USDC
                <br />
                文件：可附加研究需求；每件最多 2 MB，最多 3 件
              </p>
            </div>
          </>
        ),
      },
      {
        id: "submit",
        title: "確認並送出",
        content: (
          <>
            <p>
              建立申請後，案件會自動顯示服務比對結果。先選用服務，再按「送出採購並開始付款」；系統會重新核對報價、發票、認證與公司政策，通過後才執行付款。
            </p>
            <p>
              處理狀態由後端更新。可以離開頁面，之後由清單或同一案件網址繼續查看；重新整理不會建立新申請。
            </p>
          </>
        ),
      },
      {
        id: "review",
        title: "查看處理依據",
        content: (
          <ul>
            <li>
              <strong>申請內容：</strong>原始需求、解析後的預算及費用歸屬。
            </li>
            <li>
              <strong>供應商與政策：</strong>
              候選報價、拒絕原因、實際選用服務與政策快照。
            </li>
            <li>
              <strong>付款與對帳：</strong>
              付款識別碼、服務報告、測試發票與對帳結果。
            </li>
            <li>
              <strong>活動紀錄：</strong>系統事件與當時保留的處理依據。
            </li>
          </ul>
        ),
      },
      {
        id: "exceptions",
        title: "未核准與處理異常",
        content: (
          <>
            <p>
              預算不足或無符合發票條件的候選時，案件可能在付款前被拒絕。例如預算為
              0.03 USDC，而所有候選報價都較高，系統不會建立採購付款紀錄。
            </p>
            <p>
              若案件已有付款，發票或歸檔失敗不代表採購未發生。先查看付款證據，再使用系統提供的發票或歸檔重試。不要另建案件再次付款。
            </p>
            <div className="doc-note">
              <strong>連線中斷時</strong>
              <p>
                先回清單或重新讀取同一案件。尤其「建立申請」回應遺失時，後端可能已保存資料，請先查找再決定是否重送。
              </p>
            </div>
          </>
        ),
      },
    ],
  },
  {
    slug: "policy",
    group: "使用指南",
    title: "政策與授權",
    description: "是否允許付款由後端硬規則決定，不由介面按鈕或模型文字決定。",
    sections: [
      {
        id: "rules",
        title: "付款前的檢核",
        content: (
          <div className="doc-table">
            <table>
              <thead>
                <tr>
                  <th>檢核項目</th>
                  <th>依據</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>預算與支出上限</td>
                  <td>採購需求上限、公司單筆及每日支出限制</td>
                </tr>
                <tr>
                  <td>供應商</td>
                  <td>公司政策白名單與 Registry</td>
                </tr>
                <tr>
                  <td>收款地址</td>
                  <td>實際交易條件必須與登錄的 payTo 一致</td>
                </tr>
                <tr>
                  <td>網路與資產</td>
                  <td>政策允許的鏈、USDC 資產地址與精度</td>
                </tr>
                <tr>
                  <td>發票能力</td>
                  <td>需求及政策是否要求台灣企業發票介接</td>
                </tr>
              </tbody>
            </table>
          </div>
        ),
      },
      {
        id: "selection",
        title: "供應商候選不等於已付款",
        content: (
          <>
            <p>
              候選被標為符合條件，只代表它通過當時的評估。實際選用服務、政策核准與付款結算是不同的紀錄，不能彼此代替。
            </p>
            <p>
              預設兩家供應商中，A 報價 0.04 USDC、不支援台灣發票；B 報價 0.05
              USDC、支援測試發票介接。當任務要求發票，A
              會被排除。實際名稱與白名單請以當前設定為準。
            </p>
          </>
        ),
      },
      {
        id: "history",
        title: "保留當時的政策",
        content: (
          <>
            <p>
              每筆採購保存付款當時的政策快照及識別雜湊。日後修改公司政策，不應以新設定覆蓋歷史付款的依據。
            </p>
            <p>
              工作區的「採購政策」頁為唯讀；修改公司與政策需透過後端受保護的管理操作。
            </p>
          </>
        ),
      },
      {
        id: "limits",
        title: "付款前控制與去重邊界",
        content: (
          <>
            <p>
              新增申請時可指定人工核准門檻，超過門檻會在案件中顯示待核准金額、服務與收款地址。採購政策頁可凍結新付款；設定由後端持久化並強制執行，已取得放行許可的在途付款不撤銷。
            </p>
            <p>
              同一 task 重跑不新增 settlement；建立回應遺失時以相同 request key 找回原申請。不同 Agent 只有共用同一業務 key 才能去重；相似內容配上新 key 仍是新案件，沒有同標的語意去重。
            </p>
          </>
        ),
      },
    ],
  },
  {
    slug: "records",
    group: "使用指南",
    title: "付款、發票與對帳",
    description: "把結算、服務交付及發票當成三份獨立證據，再核對是否一致。",
    sections: [
      {
        id: "payment",
        title: "付款證據",
        content: (
          <>
            <p>
              Payment ID 識別同一筆邏輯付款。交易識別碼則是付款 Provider
              保留的結算證據；兩者用途不同。案件詳情另保留收款地址、網路及授權雜湊。
            </p>
            <p>
              授權雜湊來自 EIP-3009 的 <code>transferWithAuthorization</code>，
              也就是 x402 在 EVM 上採用的免 gas 授權方式。案件保留該授權的有效期間、
              nonce、EIP-712 網域與 typed data 雜湊，並與結算交易雜湊綁定。
              授權與結算因此是兩份可以分別查核的證據：前者說明這筆支出當初被授權的範圍，
              後者說明資金實際如何移轉。
            </p>
            <p>
              <code>SETTLED</code> 代表 Provider 已確認結算；若模式為
              mock，它只是模擬結算，不是鏈上資金移轉。
              <code>SETTLEMENT_PENDING</code>{" "}
              代表結果待確認，不可直接視為未付款並重新支出。
            </p>
          </>
        ),
      },
      {
        id: "service",
        title: "服務交付",
        content: (
          <>
            <p>
              付款與交付狀態各自保存。只有交付為 <code>DELIVERED</code>{" "}
              時，工作區才提供「查看交付報告」。收到付款結果不代表報告已可使用。
            </p>
            <p>
              採購記錄綁定實際選用的服務與供應商，讓財務可將支出對回原始用途。
            </p>
          </>
        ),
      },
      {
        id: "invoice",
        title: "測試發票",
        content: (
          <>
            <div className="doc-note warning">
              <strong>SANDBOX / TEST INVOICE</strong>
              <p>
                目前 Adapter
                產生測試發票。不得宣稱已向財政部開立有效發票，也不能當作正式報稅憑證。
              </p>
            </div>
            <p>
              發票號碼及狀態保存於採購。若狀態為可重試，使用「重試取得發票」只重跑發票工作，不重新發動採購付款。
            </p>
          </>
        ),
      },
      {
        id: "reconcile",
        title: "對帳與歸檔",
        content: (
          <>
            <p>
              <code>MATCHED</code> 表示付款、服務與發票經核對一致；
              <code>MISMATCH</code> 表示存在差異，需要查看原始證據。
            </p>
            <p>
              對帳完成不一定代表整個案件已完成。如果仍等待歸檔確認，案件會維持處理中。最終完成狀態以案件的{" "}
              <code>COMPLETED</code> 為準。
            </p>
          </>
        ),
      },
    ],
  },
  {
    slug: "architecture",
    group: "技術參考",
    title: "系統架構",
    description: "工作區、採購服務與文件分開運行。只有主系統參與採購執行。",
    sections: [
      {
        id: "components",
        title: "執行元件",
        content: (
          <>
            <div className="doc-flow" aria-label="採購資料流">
              <span>採購工作區</span>
              <b>↓</b>
              <span>Core API · 政策與持久化工作</span>
              <b>↓</b>
              <span>Seller · x402 · Invoice Adapter</span>
              <b>↓</b>
              <span>PostgreSQL · 採購與稽核證據</span>
            </div>
            <p>
              Next.js 工作區透過驗證 session 的同源 API 代理呼叫 Core API。Core API
              由持續運行的 Node.js 服務與 durable worker 處理任務，資料保存在
              PostgreSQL。
            </p>
            <p>
              文件站是獨立 Next.js 應用，不連接採購 API、不共用工作區
              session，也不依賴 Seller 或資料庫。
            </p>
          </>
        ),
      },
      {
        id: "api",
        title: "工作區使用的介面",
        content: (
          <div className="doc-table">
            <table>
              <thead>
                <tr>
                  <th>用途</th>
                  <th>API（前綴 /api/v1）</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>查詢公司與政策</td>
                  <td>
                    <code>GET /settings</code>
                  </td>
                </tr>
                <tr>
                  <td>建立採購申請</td>
                  <td>
                    <code>POST /tasks</code>
                  </td>
                </tr>
                <tr>
                  <td>送出採購</td>
                  <td>
                    <code>POST /tasks/:id/run</code>
                  </td>
                </tr>
                <tr>
                  <td>案件與處理狀態</td>
                  <td>
                    <code>GET /tasks/:id</code>
                  </td>
                </tr>
                <tr>
                  <td>付款與憑證清單</td>
                  <td>
                    <code>GET /purchases</code>
                  </td>
                </tr>
                <tr>
                  <td>重試發票</td>
                  <td>
                    <code>POST /purchases/:id/retry-invoice</code>
                  </td>
                </tr>
                <tr>
                  <td>查詢稽核事件</td>
                  <td>
                    <code>GET /audit-events</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ),
      },
      {
        id: "modes",
        title: "環境模式",
        content: (
          <ul>
            <li>
              <code>AGENT_MODE</code> 決定使用固定解析或已設定的 AI 解析
              Provider。
            </li>
            <li>
              <code>PAYMENT_MODE</code> 區分模擬結算與實際付款整合。
            </li>
            <li>
              <code>CONTRACT_ANCHOR_MODE</code> 決定授權／完成紀錄的歸檔方式。
            </li>
            <li>
              <code>INVOICE_PROVIDER</code> 決定發票介接；目前實作為測試
              Adapter。
            </li>
          </ul>
        ),
      },
      {
        id: "trust",
        title: "部署信任邊界",
        content: (
          <>
            <p>
              工作區先以存取碼登入，使用 HttpOnly、SameSite=Strict session。API 代理拒絕匿名與跨來源寫入，僅允許列出的操作；伺服器才附加 API key，核准、凍結與付款核對另附管理 Token。錢包金鑰及 Provider 憑證只存在後端，不進入瀏覽器。
            </p>
            <div className="doc-note warning">
              <strong>受控測試環境</strong>
              <p>
                存取碼使用者共用單公司操作員權限，尚無多租戶、SSO 或正式財務職務分權。不可把可支出資金的 API 當作公開匿名服務部署；testnet 驗證也必須明確配置與管理資金。
              </p>
            </div>
          </>
        ),
      },
    ],
  },
  {
    slug: "implementation",
    group: "技術參考",
    title: "實作範圍",
    description: "清楚區分已接通的流程、環境依賴，以及尚未提供的能力。",
    sections: [
      {
        id: "available",
        title: "已接通的產品流程",
        content: (
          <ul>
            <li>採購清單、需求表單、保存後送出、案件詳情與狀態查詢。</li>
            <li>供應商候選評估、後端政策執行、歷史政策快照。</li>
            <li>付款、服務交付、測試發票、對帳及稽核紀錄查閱。</li>
            <li>依後端狀態提供發票／歸檔重試。</li>
            <li>重新整理恢復同一案件，同一 task 的冪等重跑。</li>
            <li>存取碼登入、付款前人工核准、持久化的新付款凍結。</li>
            <li>保存 request key，建立回應遺失時找回原申請，不自動另建付款。</li>
            <li>
              記錄 EIP-3009 授權內容並與結算交易綁定，作為可獨立查核的付款憑證。
            </li>
          </ul>
        ),
      },
      {
        id: "verification",
        title: "驗證時應區分的事",
        content: (
          <>
            <p>
              模擬模式可用於驗證畫面、資料持久化、政策拒絕與整條對帳流程。它不能證明真實模型的推理能力，也不能證明真實
              testnet settlement。
            </p>
            <p>
              真實 AI、x402 Provider 與 testnet
              路徑需要另外設定並驗證；交件時以實際錄製的環境與取得的證據為準，不以介面標籤代替技術實作。
            </p>
          </>
        ),
      },
      {
        id: "excluded",
        title: "不在目前範圍",
        content: (
          <ul>
            <li>正式電子發票及財政部有效開立。</li>
            <li>跨 Agent、跨 task 同服務同標的的業務去重。</li>
            <li>正式信用資料與徵信評等；現有信用報告仍為 Demo。</li>
            <li>SSO、多租戶及正式財務職務分權管理。</li>
            <li>
              Marketplace、Seller 上架後台、自架 facilitator、主網資金保管。
            </li>
            <li>
              ERC-8004 的 Identity、Reputation 與 Validation Registry。本專案沒有
              註冊 Agent 身分，也沒有寫入信譽或驗證登錄。該規格將付款視為正交主題，
              並在回饋結構中留有 <code>proofOfPayment</code>{" "}
              欄位供 x402 付款證明使用；本專案產出的授權與結算憑證屬於可供其引用的內容，
              但兩者尚未對接。
            </li>
          </ul>
        ),
      },
      {
        id: "challenge",
        title: "Cathay Challenge 的產品定位",
        content: (
          <>
            <p>
              Mello 聚焦企業
              Agent、交易授權及風險感知的財務流程自動化。重點不只是讓 Agent
              成功支付，而是讓企業在自動化之後仍保有支出控制與會計脈絡。
            </p>
            <p>
              一條有需求、有政策、有付款及對帳證據的完整採購流程，比新增未接通的介面更能說明產品價值。
            </p>
          </>
        ),
      },
    ],
  },
];
