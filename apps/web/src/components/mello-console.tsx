"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MelloLogo } from "./mello-logo";
import { useResource, Notice, ErrorMessage } from "./workspace/shared";
import { SessionGate, useSession } from "./workspace/session";
import {
  RequestList,
  NewRequest,
  PurchaseList,
  PolicyPage,
  AuditPage,
} from "./workspace/pages";
import { TaskDetail } from "./workspace/task-detail";
import type { Control, Modes, Settings } from "../lib/core-api";

const navigation = [
  { href: "/app", title: "採購申請", icon: "document" },
  { href: "/app/payments", title: "付款紀錄", icon: "payment" },
  { href: "/app/invoices", title: "發票與對帳", icon: "invoice" },
  { href: "/app/policy", title: "採購政策", icon: "policy" },
  { href: "/app/audit", title: "稽核紀錄", icon: "audit" },
];

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    document: "M5 3h10l4 4v14H5V3Zm9 0v5h5M8 12h8M8 16h6",
    payment: "M3 6h18v13H3V6Zm0 4h18M6 15h4",
    invoice: "M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3",
    policy: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
    audit: "M4 4h16v16H4V4Zm4 4h1m3 0h5m-9 4h1m3 0h5m-9 4h1m3 0h5",
  };
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function MelloConsole() {
  return (
    <SessionGate>
      <Workspace />
    </SessionGate>
  );
}

function Workspace() {
  const pathname = usePathname();
  const session = useSession();
  const settings = useResource<Settings>("/settings");
  const controls = useResource<Control>("/controls");
  const health = useResource<{ modes: Modes }>("/demo/health");
  const section =
    navigation.find(
      (item) => item.href !== "/app" && pathname.startsWith(item.href),
    ) ?? navigation[0];
  const taskId =
    pathname.startsWith("/app/tasks/") && pathname !== "/app/tasks/new"
      ? pathname.split("/")[3]
      : null;
  const page =
    pathname === "/app/tasks/new" ? (
      <NewRequest
        settings={settings.data}
        frozen={controls.data?.paymentsFrozen ?? true}
      />
    ) : taskId ? (
      <TaskDetail
        taskId={taskId}
        frozen={controls.data?.paymentsFrozen ?? true}
      />
    ) : pathname === "/app/payments" ? (
      <PurchaseList />
    ) : pathname === "/app/invoices" ? (
      <PurchaseList invoices />
    ) : pathname === "/app/policy" ? (
      <PolicyPage resource={settings} controls={controls} />
    ) : pathname === "/app/audit" ? (
      <AuditPage />
    ) : pathname === "/app" ? (
      <RequestList />
    ) : (
      <Notice title="找不到此頁面">
        <Link href="/app">返回採購申請</Link>
      </Notice>
    );

  return (
    <div className="workspace">
      <header className="workspace-header">
        <Link
          href="/app"
          aria-label="Mello 採購工作區"
          className="workspace-brand"
        >
          <MelloLogo light={false} />
        </Link>
        <span className="workspace-product">採購與付款管理</span>
        <div className="workspace-organization">
          <span className="organization-mark" aria-hidden="true">
            企
          </span>
          <span>
            {settings.data?.company?.legalName ?? "企業工作區"}
            <small>
              {settings.data?.company?.defaultCostCenter ?? "Purchase-to-Pay"}
            </small>
          </span>
        </div>
        <button
          className="workspace-button"
          disabled={session.busy}
          onClick={session.logout}
        >
          {session.busy ? "登出中…" : "登出"}
        </button>
      </header>
      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <p className="nav-caption">工作區</p>
          <nav aria-label="工作區導覽">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={section.href === item.href ? "page" : undefined}
              >
                <NavIcon name={item.icon} />
                {item.title}
              </Link>
            ))}
          </nav>
          <div className="workspace-environment">
            <span className="nav-caption">運作環境</span>
            <p>
              付款{" "}
              <strong>
                {health.data?.modes.payment === "mock"
                  ? "模擬結算"
                  : (health.data?.modes.payment ?? "未連線")}
              </strong>
            </p>
            <p>
              發票{" "}
              <strong>
                {health.data?.modes.invoice ? "測試介接" : "未連線"}
              </strong>
            </p>
            <small>測試發票不具正式憑證效力。</small>
          </div>
        </aside>
        <main className="workspace-main" id="main-content">
          <div className="workspace-breadcrumb">
            工作區 <span>/</span> {section.title}
            {taskId && (
              <>
                <span>/</span> 案件詳情
              </>
            )}
            {pathname.endsWith("/new") && (
              <>
                <span>/</span> 新增申請
              </>
            )}
          </div>
          <div className="workspace-content" key={pathname}>
            <ErrorMessage error={settings.error} retry={settings.refresh} />
            <ErrorMessage error={controls.error} retry={controls.refresh} />
            {settings.data &&
              (!settings.data.company ||
                !settings.data.policy ||
                !settings.data.services.length) && (
                <Notice title="後端尚未完成初始化">
                  請管理員初始化公司、政策與供應商後重新讀取。
                  <p>
                    <button
                      className="workspace-button"
                      onClick={settings.refresh}
                    >
                      重新讀取設定
                    </button>
                  </p>
                </Notice>
              )}
            {controls.data?.paymentsFrozen && (
              <div className="case-alert" role="status">
                新付款已凍結；已放行的在途付款仍可能結算。
                <Link href="/app/policy">查看付款控制 →</Link>
              </div>
            )}
            {page}
          </div>
          <footer className="workspace-footer">
            Mello · 採購、付款與憑證，集中留存。
          </footer>
        </main>
      </div>
    </div>
  );
}
