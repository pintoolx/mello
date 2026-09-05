-- A verified payment is fenced before calling the external facilitator. Once
-- fenced, it cannot be reclaimed by an expired processing lease because the
-- settlement outcome may be ambiguous after a process or network failure.
ALTER TYPE "SellerPaymentCacheStatus" ADD VALUE 'SETTLING' BEFORE 'COMPLETED';
