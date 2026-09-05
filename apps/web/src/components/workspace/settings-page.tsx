"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, money, type Company, type Health, type Settings } from "../../lib/core-api";
import { companyFields, creditBalanceAtomic } from "../../lib/settings";
import { ErrorMessage, Field, Notice, PageHeading, useResource } from "./shared";

export function SettingsPage({ resource, health }: {
  resource: ReturnType<typeof useResource<Settings>>;
  health: ReturnType<typeof useResource<Health>>;
}) {
  return (
    <>
      <PageHeading title="設定" description="管理公司基本資訊、開立發票資料與可用餘額。" />
      {resource.data?.company && <CompanyProfile company={resource.data.company} />}
      <div className="settings-layout">
        {resource.data?.company ? (
          <CompanyForm company={resource.data.company} onSaved={resource.refresh} />
        ) : (
          <Notice title={resource.loading ? "正在讀取公司設定…" : "公司設定尚未載入"}>
            {!resource.loading && <button className="workspace-button" onClick={resource.refresh}>重新讀取</button>}
          </Notice>
        )}
        <Credit health={health.error ? null : health.data} loading={health.loading} />
      </div>
    </>
  );
}

function CompanyProfile({ company }: { company: Company }) {
  return (
    <section className="settings-profile" aria-label="公司識別">
      <span className="settings-avatar" aria-hidden="true">
        <Image src="/brand/mello-cat-green.svg" alt="" width={34} height={29} />
      </span>
      <div>
        <h2>{company.legalName}</h2>
        <p>統一編號 {company.businessId}</p>
      </div>
    </section>
  );
}

function Credit({ health, loading }: { health: Health | null; loading: boolean }) {
  const [notice, setNotice] = useState(false);
  const balance = creditBalanceAtomic(health);
  return (
    <section className="workspace-panel settings-credit" aria-labelledby="credit-title">
      <div className="panel-heading"><h2 id="credit-title">Credit</h2></div>
      <div className="credit-content">
        <p className="credit-balance" aria-live="polite" aria-busy={loading}
          title={!loading && balance === null ? "目前無法讀取實際餘額" : undefined}>
          <strong>{loading ? "讀取中…" : money(balance)}</strong><span>USDC</span>
        </p>
        <button className="workspace-button" type="button" onClick={() => setNotice(true)}>
          <span aria-hidden="true">＋</span> Top up <span className="mock-label">Mock</span>
        </button>
        {notice && <p className="credit-notice" role="status">Mock 展示，尚未進行加值。</p>}
      </div>
    </section>
  );
}

function CompanyForm({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [saved, setSaved] = useState(() => companyFields(company));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function change(field: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !dirty) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const input = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()]));
      const result = await api<Company>("/company", { method: "PUT", body: JSON.stringify(input) });
      const next = companyFields(result);
      setSaved(next);
      setDraft(next);
      setMessage("設定已儲存。");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("設定未能儲存，請稍後重試。"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <ErrorMessage error={error} />
      <section className="workspace-panel">
        <div className="panel-heading"><h2>公司基本資訊</h2><span>＊ 必填</span></div>
        <fieldset className="form-fields settings-fields" disabled={busy}>
          <div className="form-field settings-wide">
            <label htmlFor="company-name">公司法定名稱 <span>＊</span></label>
            <input id="company-name" name="organization" autoComplete="organization" required maxLength={100}
              value={draft.legalName} onChange={(event) => change("legalName", event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="business-id">統一編號 <span>＊</span></label>
            <input id="business-id" name="businessId" inputMode="numeric" required pattern="[0-9]{8}" maxLength={8}
              value={draft.businessId} onChange={(event) => change("businessId", event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="cost-center">預設成本中心 <span>＊</span></label>
            <input id="cost-center" name="defaultCostCenter" required maxLength={64}
              value={draft.defaultCostCenter} onChange={(event) => change("defaultCostCenter", event.target.value)} />
          </div>
          <div className="form-field settings-wide">
            <label htmlFor="finance-email">財務 Email <span>＊</span></label>
            <input id="finance-email" name="email" type="email" autoComplete="email" required maxLength={254}
              value={draft.email} onChange={(event) => change("email", event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="contact-name">聯絡人</label>
            <input id="contact-name" name="contactName" autoComplete="name" maxLength={100}
              value={draft.contactName} onChange={(event) => change("contactName", event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="contact-phone">聯絡電話</label>
            <input id="contact-phone" name="phone" type="tel" autoComplete="tel" maxLength={32}
              value={draft.phone} onChange={(event) => change("phone", event.target.value)} />
          </div>
          <div className="form-field settings-wide">
            <label htmlFor="company-address">公司地址</label>
            <input id="company-address" name="address" autoComplete="street-address" maxLength={255}
              value={draft.address} onChange={(event) => change("address", event.target.value)} />
          </div>
        </fieldset>
      </section>
      <section className="workspace-panel">
        <div className="panel-heading"><h2>開立發票資訊</h2><span>企業發票</span></div>
        <dl className="settings-invoice-heading">
          <Field label="發票抬頭">{draft.legalName || "尚未填寫公司名稱"}</Field>
          <Field label="發票統一編號" mono>{draft.businessId || "尚未填寫統編"}</Field>
        </dl>
        <fieldset className="form-fields settings-fields" disabled={busy}>
          <div className="form-field settings-wide">
            <label htmlFor="invoice-email">發票收件 Email</label>
            <input id="invoice-email" name="invoiceEmail" type="email" maxLength={254} placeholder={draft.email}
              aria-describedby="invoice-email-help" value={draft.invoiceEmail} onChange={(event) => change("invoiceEmail", event.target.value)} />
            <small id="invoice-email-help">留白則沿用財務 Email：{draft.email || "尚未填寫"}</small>
          </div>
          <div className="form-field settings-wide">
            <label htmlFor="invoice-address">發票地址</label>
            <input id="invoice-address" name="invoiceAddress" maxLength={255} placeholder={draft.address || "沿用公司地址"}
              aria-describedby="invoice-address-help" value={draft.invoiceAddress} onChange={(event) => change("invoiceAddress", event.target.value)} />
            <small id="invoice-address-help">留白則沿用公司地址。抬頭與統編使用上方的公司資料。</small>
          </div>
        </fieldset>
        <p className="settings-note">變更適用於新採購，既有採購保留原發票資料。目前為測試發票介接，不實際寄送 Email。</p>
        <div className="form-footer settings-footer">
          <span role="status">{busy ? "儲存中…" : dirty ? "有尚未儲存的變更" : message || "所有變更已儲存"}</span>
          <div className="page-actions">
            <button className="workspace-button" type="button" disabled={!dirty || busy} onClick={() => {
              setDraft(saved); setError(null); setMessage("");
            }}>取消變更</button>
            <button className="workspace-button primary" type="submit" disabled={!dirty || busy}>
              {busy ? "儲存中…" : "儲存設定"}
            </button>
          </div>
        </div>
      </section>
    </form>
  );
}
