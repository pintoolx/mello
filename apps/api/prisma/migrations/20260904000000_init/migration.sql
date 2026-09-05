-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('CREATED', 'PARSING', 'DISCOVERING', 'EVALUATING', 'REJECTED', 'AUTH_ANCHOR_PENDING', 'PAYING', 'DELIVERING', 'INVOICING', 'RECONCILING', 'FINAL_ANCHOR_PENDING', 'COMPLETED', 'ACTION_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('CREATED', 'AUTH_ANCHOR_PENDING', 'AUTHORIZED', 'PAYING', 'SETTLED', 'DELIVERED', 'INVOICING', 'RECONCILING', 'FINAL_ANCHOR_PENDING', 'COMPLETED', 'ACTION_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "InvoiceCapability" AS ENUM ('NONE', 'TW_B2B_DEMO');

-- CreateEnum
CREATE TYPE "InvoiceProvider" AS ENUM ('NONE', 'MOCK', 'ECPAY_STAGE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_STARTED', 'AUTHORIZED', 'SETTLEMENT_PENDING', 'SETTLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentAuthorizationStatus" AS ENUM ('CREATED', 'SIGNED', 'SUBMITTED', 'SETTLED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'ISSUED_DEMO', 'ISSUED_STAGE', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCH');

-- CreateEnum
CREATE TYPE "AnchorKind" AS ENUM ('AUTHORIZE', 'FINALIZE', 'FAIL');

-- CreateEnum
CREATE TYPE "AnchorStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED_RETRYABLE');

-- CreateEnum
CREATE TYPE "WorkflowJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateTable
CREATE TABLE "CompanyProfile" (
    "id" UUID NOT NULL,
    "legalName" VARCHAR(100) NOT NULL,
    "businessId" CHAR(8) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "defaultCostCenter" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "perTxLimitAtomic" VARCHAR(78) NOT NULL,
    "dailyLimitAtomic" VARCHAR(78) NOT NULL,
    "requireTwInvoice" BOOLEAN NOT NULL DEFAULT true,
    "allowedNetworks" JSONB NOT NULL,
    "allowedTokens" JSONB NOT NULL,
    "allowedSellerIds" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" VARCHAR(64) NOT NULL,
    "legalName" VARCHAR(100) NOT NULL,
    "businessId" CHAR(8),
    "payToAddress" VARCHAR(42) NOT NULL,
    "invoiceCapability" "InvoiceCapability" NOT NULL,
    "invoiceProvider" "InvoiceProvider" NOT NULL,
    "status" "SellerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" VARCHAR(64) NOT NULL,
    "sellerId" VARCHAR(64) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "priceAtomic" VARCHAR(78) NOT NULL,
    "tokenSymbol" VARCHAR(16) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "network" VARCHAR(64) NOT NULL,
    "supportsTwInvoice" BOOLEAN NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "intent" JSONB,
    "candidates" JSONB,
    "decisionSummary" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'CREATED',
    "errorCode" VARCHAR(64),
    "errorMessage" TEXT,
    "usedFallbackParser" BOOLEAN NOT NULL DEFAULT false,
    "runStartedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "serviceId" VARCHAR(64) NOT NULL,
    "paymentId" VARCHAR(128) NOT NULL,
    "expectedAmountAtomic" VARCHAR(78) NOT NULL,
    "actualAmountAtomic" VARCHAR(78),
    "network" VARCHAR(64) NOT NULL,
    "tokenSymbol" VARCHAR(16) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "buyerAddress" VARCHAR(42) NOT NULL,
    "payToAddress" VARCHAR(42) NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "mandateHash" CHAR(66) NOT NULL,
    "policyHash" CHAR(66) NOT NULL,
    "paymentAuthorizationHash" CHAR(66),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "paymentId" VARCHAR(128) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "payerAddress" VARCHAR(42),
    "payeeAddress" VARCHAR(42),
    "amountAtomic" VARCHAR(78),
    "network" VARCHAR(64),
    "tokenAddress" VARCHAR(42),
    "transactionHash" CHAR(66),
    "paymentRequired" JSONB,
    "paymentResponse" JSONB,
    "authorizedAt" TIMESTAMPTZ(3),
    "settledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAuthorization" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "paymentId" VARCHAR(128) NOT NULL,
    "standard" VARCHAR(32) NOT NULL DEFAULT 'ERC3009',
    "scheme" VARCHAR(32) NOT NULL DEFAULT 'exact',
    "network" VARCHAR(64) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "fromAddress" VARCHAR(42) NOT NULL,
    "toAddress" VARCHAR(42) NOT NULL,
    "amountAtomic" VARCHAR(78) NOT NULL,
    "nonce" CHAR(66) NOT NULL,
    "validAfter" BIGINT NOT NULL,
    "validBefore" BIGINT NOT NULL,
    "eip712Name" VARCHAR(128) NOT NULL,
    "eip712Version" VARCHAR(32) NOT NULL,
    "eip712ChainId" BIGINT NOT NULL,
    "typedDataHash" CHAR(66) NOT NULL,
    "signatureHash" CHAR(66),
    "status" "PaymentAuthorizationStatus" NOT NULL DEFAULT 'CREATED',
    "settlementTxHash" CHAR(66),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "responseBody" JSONB,
    "responseHash" CHAR(66),
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "provider" "InvoiceProvider" NOT NULL DEFAULT 'MOCK',
    "providerReference" VARCHAR(128),
    "invoiceNumber" VARCHAR(64),
    "buyerBusinessId" CHAR(8),
    "sellerBusinessId" CHAR(8),
    "sellerProfileId" VARCHAR(64),
    "sourceAmountAtomic" VARCHAR(78),
    "fxRateTwdPerUsdc" VARCHAR(32),
    "twdEquivalentMinor" VARCHAR(78),
    "itemName" VARCHAR(255),
    "paymentId" VARCHAR(128),
    "paymentTxHash" CHAR(66),
    "canonicalHash" CHAR(66),
    "disclaimer" VARCHAR(255),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "checks" JSONB NOT NULL,
    "canonicalHash" CHAR(66),
    "reconciledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "aggregateType" VARCHAR(32) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "actorType" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "requestId" VARCHAR(128),
    "taskId" UUID,
    "purchaseId" UUID,
    "paymentId" VARCHAR(128),
    "sellerId" VARCHAR(64),
    "stage" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnchainAnchor" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "kind" "AnchorKind" NOT NULL,
    "status" "AnchorStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "contractAddress" VARCHAR(42),
    "transactionHash" CHAR(66),
    "blockNumber" BIGINT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(64),
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OnchainAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPaymentCache" (
    "id" UUID NOT NULL,
    "sellerId" VARCHAR(64) NOT NULL,
    "route" VARCHAR(255) NOT NULL,
    "paymentId" VARCHAR(128) NOT NULL,
    "fingerprint" CHAR(66) NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseHeaders" JSONB NOT NULL,
    "responseBody" JSONB NOT NULL,
    "settlementMetadata" JSONB,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerPaymentCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowJob" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WorkflowJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "lockedBy" VARCHAR(128),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Policy_version_key" ON "Policy"("version");

-- CreateIndex
CREATE INDEX "Policy_active_idx" ON "Policy"("active");

-- CreateIndex
CREATE INDEX "Service_category_active_idx" ON "Service"("category", "active");

-- CreateIndex
CREATE INDEX "Task_status_createdAt_idx" ON "Task"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_taskId_key" ON "Purchase"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_paymentId_key" ON "Purchase"("paymentId");

-- CreateIndex
CREATE INDEX "Purchase_status_createdAt_idx" ON "Purchase"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_purchaseId_key" ON "Payment"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentId_key" ON "Payment"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAuthorization_purchaseId_key" ON "PaymentAuthorization"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAuthorization_paymentId_key" ON "PaymentAuthorization"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAuthorization_nonce_key" ON "PaymentAuthorization"("nonce");

-- CreateIndex
CREATE INDEX "PaymentAuthorization_status_validBefore_idx" ON "PaymentAuthorization"("status", "validBefore");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_purchaseId_key" ON "Delivery"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_purchaseId_key" ON "Invoice"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_purchaseId_key" ON "Reconciliation"("purchaseId");

-- CreateIndex
CREATE INDEX "AuditEvent_aggregateType_aggregateId_createdAt_idx" ON "AuditEvent"("aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_taskId_createdAt_idx" ON "AuditEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_purchaseId_createdAt_idx" ON "AuditEvent"("purchaseId", "createdAt");

-- CreateIndex
CREATE INDEX "OnchainAnchor_status_updatedAt_idx" ON "OnchainAnchor"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnchainAnchor_purchaseId_kind_key" ON "OnchainAnchor"("purchaseId", "kind");

-- CreateIndex
CREATE INDEX "SellerPaymentCache_expiresAt_idx" ON "SellerPaymentCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPaymentCache_sellerId_route_paymentId_key" ON "SellerPaymentCache"("sellerId", "route", "paymentId");

-- CreateIndex
CREATE INDEX "WorkflowJob_status_availableAt_idx" ON "WorkflowJob"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainAnchor" ADD CONSTRAINT "OnchainAnchor_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
