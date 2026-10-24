ALTER TABLE "DistributionRule" ADD COLUMN "notificationPhone" TEXT;

ALTER TABLE "Message"
  ADD COLUMN "notificationPhone" TEXT,
  ADD COLUMN "notificationName" TEXT,
  ADD COLUMN "notificationStatus" TEXT,
  ADD COLUMN "notificationProviderMessageId" TEXT,
  ADD COLUMN "notificationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notificationLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "notificationSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "notificationFailureReason" TEXT,
  ADD COLUMN "notificationUncertain" BOOLEAN NOT NULL DEFAULT false;
