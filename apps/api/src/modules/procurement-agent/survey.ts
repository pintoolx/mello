import { hashCanonicalJson, type CandidateEvaluation, type ServiceRecord, type TaskRequirements } from "@mello/shared";
import { approvalTerms } from "../controls/procurement-controls.js";
import { serviceBindingHash } from "../service-registry/verification.js";

export function surveyCandidate(candidate: CandidateEvaluation, service: ServiceRecord,
  requirements: TaskRequirements, verification: { status: string; revision: number | null },
  discoveryReasons: string[] = [], discoverySource = "local_registry") {
  const matchesRequirements = service.active &&
    (!requirements.requiresTwInvoice || (service.supportsTwInvoice && service.invoiceCapability !== "NONE")) &&
    (!requirements.requiresRegistryCertification || verification.status === "VERIFIED");
  const reasons = [...(candidate.eligible ? [] : candidate.reasonCodes), ...discoveryReasons];
  if (requirements.requiresRegistryCertification && verification.status !== "VERIFIED" &&
    !reasons.some((reason) => reason.startsWith("VERIFICATION_"))) reasons.push(`VERIFICATION_${verification.status}`);
  return {
    ...candidate, matchesRequirements, discoverySource, verificationStatus: verification.status,
    selectionHash: hashCanonicalJson({ terms: approvalTerms(service), bindingHash: serviceBindingHash(service),
      verificationRevision: requirements.requiresRegistryCertification ? verification.revision : null }),
    eligible: matchesRequirements && reasons.length === 0,
    reasonCodes: reasons.length ? [...new Set(reasons)] : ["CANDIDATE_ELIGIBLE"],
    humanSummary: reasons.length ? `${service.sellerLegalName} 尚未符合付款條件：${[...new Set(reasons)].join("、")}。`
      : `${service.sellerLegalName} 符合本次需求，可由你確認選用。`,
  };
}
