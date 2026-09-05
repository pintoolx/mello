ALTER TYPE "TaskStatus" ADD VALUE 'WAITING_SELECTION';

ALTER TABLE "TaskControl"
  ADD COLUMN "requirements" JSONB,
  ADD COLUMN "selectedService" JSONB;
