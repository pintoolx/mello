"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api-client";
import type { Control, Health, Settings, Task, TaskSummary } from "./console-types";

const TERMINAL = new Set(["COMPLETED", "REJECTED", "ACTION_REQUIRED", "FAILED"]);
const PENDING_KEY = "mello:pending-request";
type TaskInput = { prompt: string; requestKey: string; approvalLimitAtomic?: string; expectedPayTo?: string };

export function useMelloConsole() {
  const [session, setSession] = useState<"loading" | "authenticated" | "anonymous">("loading");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [history, setHistory] = useState<TaskSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [watchTick, setWatchTick] = useState(0);
  const [watching, setWatching] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const actionLock = useRef(false);
  const baseline = useRef<string | null>(null);

  const reportError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) setSession("anonymous");
    setError(reason instanceof Error ? `${reason.message}${reason instanceof ApiError && reason.requestId ? `（${reason.requestId}）` : ""}` : "操作失敗，請重新整理狀態");
  }, []);

  const refreshBase = useCallback(async () => {
    const [nextSettings, nextControl, tasks, nextHealth] = await Promise.all([
      api<Settings>("/api/v1/settings"), api<Control>("/api/v1/controls"),
      api<{ items: TaskSummary[] }>("/api/v1/tasks?limit=20"), api<Health>("/api/v1/demo/health"),
    ]);
    setSettings(nextSettings); setControl(nextControl); setHistory(tasks.items); setHealth(nextHealth);
  }, []);

  const watch = useCallback((taskId: string, previousVersion: string | null = null) => {
    setTask(current => current?.taskId === taskId ? current : null);
    baseline.current = previousVersion;
    setActiveId(taskId); setWatchTick(value => value + 1); setWatching(true);
    const url = new URL(window.location.href);
    url.searchParams.set("task", taskId);
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api<{ authenticated: boolean }>("/api/session");
        if (cancelled) return;
        setSession(result.authenticated ? "authenticated" : "anonymous");
        if (result.authenticated) {
          await refreshBase();
          const restored = new URL(window.location.href).searchParams.get("task");
          if (!cancelled && restored && /^[\da-f-]{36}$/i.test(restored)) watch(restored);
        }
      } catch (reason) { if (!cancelled) reportError(reason); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [refreshBase, reportError, watch]);

  useEffect(() => {
    if (!activeId || session !== "authenticated") return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Task>(`/api/v1/tasks/${activeId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setTask(next);
        if (next.status === "CREATED" && Date.now() - startedAt > 15_000) {
          setWatching(false); setNotice("任務已保存但尚未執行，可按「繼續執行既有任務」，不必重建採購。"); return;
        }
        if (baseline.current && next.updatedAt !== baseline.current) baseline.current = null;
        if (TERMINAL.has(next.status) && !baseline.current) {
          setWatching(false);
          const tasks = await api<{ items: TaskSummary[] }>("/api/v1/tasks?limit=20", { signal: controller.signal });
          if (!controller.signal.aborted) setHistory(tasks.items);
          return;
        }
        timer = setTimeout(poll, 750);
      } catch (reason) {
        if (!controller.signal.aborted) { reportError(reason); setWatching(false); }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeId, watchTick, session, reportError]);

  const operate = async (fn: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setWorking(true); setError(""); setNotice("");
    try { await fn(); } catch (reason) { reportError(reason); }
    finally { actionLock.current = false; setWorking(false); }
  };

  async function login(code: string) {
    await operate(async () => {
      await api("/api/session", { method: "POST", body: JSON.stringify({ code }) });
      setSession("authenticated"); setLoading(true);
      try { await refreshBase(); } finally { setLoading(false); }
      const restored = new URL(window.location.href).searchParams.get("task");
      if (restored && /^[\da-f-]{36}$/i.test(restored)) watch(restored);
    });
  }

  async function start(prompt: string, expectedPayTo?: string) {
    await operate(async () => {
      const saved = localStorage.getItem(PENDING_KEY);
      const input: TaskInput = saved ? JSON.parse(saved) : { prompt, requestKey: crypto.randomUUID(), ...(expectedPayTo ? { expectedPayTo } : {}) };
      if (saved && (input.prompt !== prompt || input.expectedPayTo !== expectedPayTo)) {
        throw new Error("前一筆建立請求尚未確認，請先以原內容重試或從採購紀錄找回；不會自動建立第二筆付款。");
      }
      localStorage.setItem(PENDING_KEY, JSON.stringify(input));
      const created = await api<{ taskId: string; deduplicated: boolean }>("/api/v1/tasks", { method: "POST", body: JSON.stringify(input) });
      localStorage.removeItem(PENDING_KEY);
      setTask(null); watch(created.taskId);
      await api(`/api/v1/tasks/${created.taskId}/run`, { method: "POST" });
      if (created.deduplicated) setNotice("已找回相同請求的既有任務，沒有另建採購。");
    });
  }

  async function duplicate() {
    if (!task?.control) return;
    await operate(async () => {
      const input: TaskInput = { prompt: task.prompt, requestKey: task.control!.requestKey,
        ...(task.control!.approvalLimitAtomic !== null ? { approvalLimitAtomic: task.control!.approvalLimitAtomic } : {}),
        ...(task.control!.expectedPayTo ? { expectedPayTo: task.control!.expectedPayTo } : {}) };
      const result = await api<{ taskId: string; deduplicated: boolean }>("/api/v1/tasks", { method: "POST", body: JSON.stringify(input) });
      if (!result.deduplicated || result.taskId !== task.taskId) throw new Error("去重結果異常，請停止操作並檢查紀錄");
      await api(`/api/v1/tasks/${task.taskId}/run`, { method: "POST" });
      setNotice("DUPLICATE_PURCHASE · 已回傳同一採購，未新增付款。"); watch(task.taskId);
    });
  }

  async function retry(kind: "retry-invoice" | "retry-anchor" | "reconcile-payment" | "approve") {
    if (!task) return;
    await operate(async () => {
      await api(`/api/v1/tasks/${task.taskId}/${kind}`, { method: "POST" });
      watch(task.taskId, task.updatedAt);
      setNotice(kind === "retry-invoice" ? "僅重試發票，不重新付款。" : "操作已排程，等待後端更新。");
    });
  }

  async function freeze() {
    if (!control) return;
    await operate(async () => {
      const next = await api<Control>("/api/v1/controls", { method: "PUT", body: JSON.stringify({ paymentsFrozen: !control.paymentsFrozen }) });
      setControl(next);
      setNotice(next.paymentsFrozen ? "新付款已凍結；已取得送出許可的在途付款不會被撤銷。" : "已解除新付款凍結。");
    });
  }

  function reset() {
    setActiveId(null); setTask(null); setWatching(false); setError(""); setNotice("已清空目前畫面，後端採購、付款與稽核紀錄仍保留。");
    const url = new URL(window.location.href); url.searchParams.delete("task"); window.history.replaceState(null, "", url);
  }

  async function refresh() { await operate(async () => { await refreshBase(); if (activeId) watch(activeId); }); }
  async function resume() { if (task) await operate(async () => { await api(`/api/v1/tasks/${task.taskId}/run`, { method: "POST" }); watch(task.taskId); }); }
  async function logout() { await operate(async () => { await api("/api/session", { method: "DELETE" }); setSession("anonymous"); setSettings(null); setTask(null); setActiveId(null); setWatching(false); }); }

  return { session, settings, health, control, task, history, error, notice, working, watching, loading,
    busy: working || watching, ready: session === "authenticated" && !!settings && !!control && !loading,
    login, logout, start, duplicate, retry, freeze, reset, refresh, resume, selectTask: watch };
}
