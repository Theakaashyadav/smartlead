CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- Keep the original installation together; new registrations create new organisations.
INSERT INTO "Organization" ("id", "name") VALUES ('legacy', 'My Organisation');

ALTER TABLE "User" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Sheet" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Sender" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Employee" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "GoogleCredential" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Job" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy';

DROP INDEX "Sheet_spreadsheetId_worksheetId_key";
DROP INDEX "Employee_phone_key";
CREATE UNIQUE INDEX "Sheet_organizationId_spreadsheetId_worksheetId_key" ON "Sheet"("organizationId", "spreadsheetId", "worksheetId");
CREATE UNIQUE INDEX "Employee_organizationId_phone_key" ON "Employee"("organizationId", "phone");

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sheet" ADD CONSTRAINT "Sheet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sender" ADD CONSTRAINT "Sender_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoogleCredential" ADD CONSTRAINT "GoogleCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
