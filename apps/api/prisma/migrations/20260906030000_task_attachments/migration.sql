ALTER TABLE "TaskControl" ADD COLUMN "discoveryJobId" UUID;

CREATE TABLE "TaskAttachment" (
  "id" UUID NOT NULL,
  "taskId" UUID,
  "requestKey" VARCHAR(128) NOT NULL,
  "clientFileId" UUID NOT NULL,
  "fileName" VARCHAR(180) NOT NULL,
  "mediaType" VARCHAR(100) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "content" BYTEA NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "TaskAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskAttachment_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 2097152 AND octet_length("content") = "sizeBytes"),
  CONSTRAINT "TaskAttachment_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "TaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TaskAttachment_requestKey_clientFileId_key" ON "TaskAttachment"("requestKey", "clientFileId");
CREATE INDEX "TaskAttachment_taskId_createdAt_idx" ON "TaskAttachment"("taskId", "createdAt");
CREATE INDEX "TaskAttachment_taskId_expiresAt_idx" ON "TaskAttachment"("taskId", "expiresAt");
