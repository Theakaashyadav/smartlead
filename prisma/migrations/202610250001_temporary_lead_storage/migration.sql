-- PostgreSQL compatibility. Production MongoDB creates the expiring lookup
-- collection and indexes at worker startup; existing records are not dropped.
ALTER TABLE "Sheet" ADD COLUMN IF NOT EXISTS "sourceSummary" JSONB;

CREATE TABLE "FeedbackLink" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "sheetId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "encryptedSourceId" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "outputHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "FeedbackLink_tokenHash_key" ON "FeedbackLink"("tokenHash");
CREATE INDEX "FeedbackLink_sheetId_sourceHash_idx" ON "FeedbackLink"("sheetId", "sourceHash");
CREATE INDEX "FeedbackLink_leadId_idx" ON "FeedbackLink"("leadId");
