"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { requestJson, SESSION_EXPIRED } from "../../lib/core-api";
import { MelloLogo } from "../mello-logo";
import { ErrorMessage, Notice } from "./shared";

const SessionContext = createContext({ logout: () => {}, busy: false });
export const useSession = () => useContext(SessionContext);

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "authenticated" | "anonymous">(
    "loading",
  );
  const [configured, setConfigured] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const expire = () => {
      setState("anonymous");
      setError(new Error("登入已失效，請重新輸入存取碼。既有案件仍保留。"));
    };
    window.addEventListener(SESSION_EXPIRED, expire);
    void requestJson<{ authenticated: boolean; configured: boolean }>(
      "/api/session",
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setConfigured(result.configured);
        setState(result.authenticated ? "authenticated" : "anonymous");
        setError(null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause : new Error("無法確認登入狀態"),
          );
      });
    return () => {
      controller.abort();
      window.removeEventListener(SESSION_EXPIRED, expire);
    };
  }, [version]);

  async function changeSession(login: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/session", {
        method: login ? "POST" : "DELETE",
        ...(login ? { body: JSON.stringify({ code }) } : {}),
      });
      setCode("");
      setState(login ? "authenticated" : "anonymous");
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("登入操作未完成"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (state === "authenticated")
    return (
      <SessionContext.Provider
        value={{ logout: () => void changeSession(false), busy }}
      >
        {error && (
          <div className="workspace session-error">
            <ErrorMessage error={error} />
          </div>
        )}
        {children}
      </SessionContext.Provider>
    );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void changeSession(true);
  }
  return (
    <main className="workspace session-screen" id="main-content">
      <section
        className="workspace-panel session-panel"
        aria-labelledby="session-title"
      >
        <div className="panel-heading">
          <MelloLogo light={false} />
        </div>
        <div className="form-fields">
          <div>
            <h1 id="session-title">登入採購工作區</h1>
            <p>使用管理員提供的存取碼，查看案件與操作付款。</p>
          </div>
          <ErrorMessage
            error={error}
            retry={() => setVersion((value) => value + 1)}
          />
          {state === "loading" ? (
            !error && <Notice title="正在確認登入狀態…" />
          ) : !configured ? (
            <Notice title="尚未設定登入環境">
              請管理員設定伺服器存取碼與 session secret，再重新讀取。
            </Notice>
          ) : (
            <form onSubmit={submit} className="session-form">
              <div className="form-field">
                <label htmlFor="access-code">工作區存取碼</label>
                <input
                  id="access-code"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={busy}
                />
              </div>
              <button className="workspace-button primary" disabled={busy}>
                {busy ? "登入中…" : "登入工作區"}
              </button>
              <p className="panel-note">
                共用測試操作員權限，僅限受邀人員。存取碼不是錢包私鑰。
              </p>
            </form>
          )}
          {!configured && (
            <button
              className="workspace-button"
              onClick={() => setVersion((value) => value + 1)}
            >
              重新讀取
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
