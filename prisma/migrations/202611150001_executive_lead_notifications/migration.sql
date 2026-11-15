ALTER TABLE "DistributionRule" ADD COLUMN "executiveNotificationPhone" TEXT;

ALTER TABLE "Message"
  ADD COLUMN "executiveNotificationPhone" TEXT,
  ADD COLUMN "executiveNotificationStatus" TEXT,
  ADD COLUMN "executiveNotificationProviderMessageId" TEXT,
  ADD COLUMN "executiveNotificationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executiveNotificationLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "executiveNotificationSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "executiveNotificationFailureReason" TEXT,
  ADD COLUMN "executiveNotificationUncertain" BOOLEAN NOT NULL DEFAULT false;
