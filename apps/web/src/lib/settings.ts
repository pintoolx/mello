import type { Company, Health } from "./core-api";

export function companyFields(company: Company) {
  return {
    legalName: company.legalName,
    businessId: company.businessId,
    email: company.email,
    defaultCostCenter: company.defaultCostCenter,
    contactName: company.contactName ?? "",
    phone: company.phone ?? "",
    address: company.address ?? "",
    invoiceEmail: company.invoiceEmail ?? "",
    invoiceAddress: company.invoiceAddress ?? "",
  };
}

export function creditBalanceAtomic(health: Health | null): string | null {
  const wallet = health?.checks?.buyerWallet;
  const rpc = health?.checks?.baseRpc;
  const balance = wallet?.details?.usdcBalanceAtomic;
  return health?.modes.payment === "x402"
    && rpc?.status === "ok" && rpc.details?.chainId === 84532
    && wallet?.status === "ok" && wallet.details?.simulated !== true
    && typeof balance === "string" && /^\d+$/.test(balance)
    ? balance : null;
}
