"use client";

import { useState } from "react";
import { money, type Task } from "../../lib/core-api";
import { surveyReason, visibleSurveyCandidates } from "../../lib/service-survey";
import { serviceName, supplierName } from "../../lib/service-catalog";
import { Notice } from "./shared";

export function ServiceSurvey({ task, busy, frozen, onSelect, onExplore }: {
  task: Task;
  busy: boolean;
  frozen: boolean;
  onSelect: (selection: { serviceId: string; selectionHash: string }) => void;
  onExplore: () => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const requirements = task.control?.requirements;
  const candidates = visibleSurveyCandidates(task.candidates ?? [], requirements);
  const selected = candidates.find((candidate) => candidate.selectionHash === selection && candidate.eligible);
  return (
    <section className="workspace-panel survey-panel" aria-labelledby="survey-title">
      <div className="panel-heading">
        <h2 id="survey-title">探索結果 · 選擇服務</h2>
        <span>{candidates.length} 個服務</span>
      </div>
      <div className="survey-intro">
        <p>Agent 已完成需求與服務比較。請選用一個服務，確認後再送出採購。</p>
        <div className="survey-filters">
          <span>發票：{requirements?.requiresTwInvoice ? "需要" : "不限制"}</span>
          <span>Mello Registry 認證：{requirements?.requiresRegistryCertification ? "需要" : "不限制"}</span>
        </div>
        {task.decisionSummary && <p role="status">{task.decisionSummary}</p>}
      </div>
      {candidates.length ? (
        <fieldset className="survey-options" disabled={busy}>
          <legend className="sr-only">選擇要採購的服務</legend>
          {candidates.map((candidate) => {
            const serviceId = candidate.serviceId ?? candidate.id ?? "";
            const certified = candidate.verificationStatus === "VERIFIED";
            return (
              <label className={`survey-option${candidate.selectionHash === selection ? " is-selected" : ""}${!candidate.eligible ? " is-unavailable" : ""}`} key={serviceId}>
                <input type="radio" name={`service-${task.taskId}`} value={serviceId}
                  aria-label={`選用 ${serviceName(candidate)}`}
                  checked={candidate.selectionHash === selection}
                  disabled={!candidate.eligible || !candidate.selectionHash}
                  onChange={() => setSelection(candidate.selectionHash ?? null)} />
                <span className="survey-option-content">
                  <span className="survey-option-heading"><strong>服務：{serviceName(candidate)}</strong><span>{money(candidate.priceAtomic)} USDC</span></span>
                  <small>供應商：{supplierName(candidate)}</small>
                  {candidate.description && <small>{candidate.description}</small>}
                  <span className="survey-capabilities">
                    <span className={candidate.supportsTwInvoice ? "positive-text" : "muted-text"}>發票：{candidate.supportsTwInvoice ? "有（測試發票）" : "無"}</span>
                    <span className={certified ? "positive-text" : "muted-text"}>Mello Registry 認證：{certified ? "有" : "無"}</span>
                  </span>
                  <small>{candidate.eligible ? "符合本次需求與付款條件" : (candidate.reasonCodes ?? []).map(surveyReason).join("；")}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : (
        <Notice title="目前沒有符合條件的服務">
          本次沒有相同服務類型且符合條件的選項。新服務需獨立審核，不會沿用舊信用報告認證；也不會以其他類型替代。
        </Notice>
      )}
      {candidates.length > 0 && !candidates.some((candidate) => candidate.eligible) && (
        <p className="survey-intro" role="status">目前服務皆未通過付款條件，請依各服務的原因調整需求或公司政策。</p>
      )}
      <div className="form-footer survey-footer">
        <div><strong>{selected ? `${serviceName(selected)} · ${money(selected.priceAtomic)} USDC` : "尚未選擇服務"}</strong>
          <p>{frozen ? "新付款目前已凍結，仍可查看探索結果。" : "確認選用後，系統會再次檢查報價與付款條件。"}</p></div>
        <div className="page-actions">
          <button type="button" className="workspace-button" disabled={busy} onClick={onExplore}>重新探索</button>
          <button type="button" className="workspace-button primary" disabled={busy || frozen || !selected}
            onClick={() => {
              const serviceId = selected?.serviceId ?? selected?.id;
              if (serviceId && selected?.selectionHash) onSelect({ serviceId, selectionHash: selected.selectionHash });
            }}>{busy ? "處理中…" : "送出採購並開始付款"}</button>
        </div>
      </div>
    </section>
  );
}
