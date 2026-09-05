"use client";

import { useMemo, useState } from "react";
import { dateTime, money, type Settings } from "../../lib/core-api";
import { RegistryDiscovery, verificationLabel } from "./registry-discovery";
import { Notice, PageHeading, useResource } from "./shared";

type Verified = "all" | "verified" | "unverified";
type Invoice = "all" | "yes" | "no";

export function VendorsPage({
  resource,
}: {
  resource: ReturnType<typeof useResource<Settings>>;
}) {
  const [query, setQuery] = useState("");
  const [verified, setVerified] = useState<Verified>("all");
  const [invoice, setInvoice] = useState<Invoice>("all");

  const services = resource.data?.services;
  const allowed = resource.data?.policy?.allowedSellerIds;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (services ?? []).filter((service) => {
      if (
        needle &&
        ![
          service.displayName,
          service.sellerLegalName,
          service.id,
          service.sellerId,
        ].some((value) => value?.toLowerCase().includes(needle))
      )
        return false;
      const isVerified = service.verification?.status === "VERIFIED";
      if (verified === "verified" && !isVerified) return false;
      if (verified === "unverified" && isVerified) return false;
      if (invoice === "yes" && !service.supportsTwInvoice) return false;
      if (invoice === "no" && service.supportsTwInvoice) return false;
      return true;
    });
  }, [services, query, verified, invoice]);

  return (
    <>
      <PageHeading
        title="供應商"
        description="查詢已登錄的服務、認證狀態與收款地址，並比對公共目錄的刊登內容。"
      />
      <section className="workspace-panel">
        <div className="panel-heading">
          <h2>已登錄服務</h2>
          <span>
            {services ? `${rows.length} / ${services.length} 筆` : "讀取中"}
          </span>
        </div>
        <div className="list-toolbar">
          <label className="search-field">
            <span>搜尋供應商或服務</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="名稱或服務代號"
            />
          </label>
          <label className="status-filter">
            <span>Mello 認證</span>
            <select
              value={verified}
              onChange={(event) => setVerified(event.target.value as Verified)}
            >
              <option value="all">全部</option>
              <option value="verified">已認證</option>
              <option value="unverified">未認證</option>
            </select>
          </label>
          <label className="status-filter">
            <span>台灣發票</span>
            <select
              value={invoice}
              onChange={(event) => setInvoice(event.target.value as Invoice)}
            >
              <option value="all">全部</option>
              <option value="yes">可開立</option>
              <option value="no">不支援</option>
            </select>
          </label>
        </div>
        {resource.loading ? (
          <Notice title="正在讀取供應商…" />
        ) : !rows.length ? (
          <Notice title={services?.length ? "沒有符合條件的供應商" : "尚無登錄服務"}>
            {services?.length
              ? "調整搜尋字串或篩選條件後再試。"
              : "請由管理員建立服務與審核紀錄。"}
          </Notice>
        ) : (
          <div className="table-scroll">
            <table className="records-table">
              <thead>
                <tr>
                  <th>供應商</th>
                  <th>報價</th>
                  <th>台灣發票</th>
                  <th>政策白名單</th>
                  <th>Mello 認證</th>
                  <th>登錄收款地址</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((service) => (
                  <tr key={service.id}>
                    <td>
                      <strong>
                        {service.displayName ?? service.sellerLegalName}
                      </strong>
                      {service.displayName && (
                        <small>供應商：{service.sellerLegalName}</small>
                      )}
                      <small>{service.id}</small>
                    </td>
                    <td className="nowrap">{money(service.priceAtomic)} USDC</td>
                    <td>
                      {service.supportsTwInvoice ? "支援測試介接" : "不支援"}
                    </td>
                    <td>
                      {allowed?.includes(service.sellerId) ? "已列入" : "未列入"}
                    </td>
                    <td>
                      {verificationLabel(service.verification?.status)}
                      {service.verification?.expiresAt && (
                        <small>
                          期限：{dateTime(service.verification.expiresAt)}
                        </small>
                      )}
                    </td>
                    <td className="record-id">{service.payToAddress}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <RegistryDiscovery mode={resource.data?.discoveryMode} />
      <p className="page-footnote">
        Mello 認證是人工範圍審核，不代表正式 KYB 或合法發票認證。政策白名單與商家認證分別檢查；人工核准不會覆蓋任一限制。
      </p>
    </>
  );
}
