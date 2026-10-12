-- Enforce one accountable owner even if independent application processes race.
CREATE UNIQUE INDEX "Assignment_one_active_primary_owner"
ON "Assignment" ("leadId")
WHERE "active" = true AND "isPrimary" = true;

ALTER TABLE "User" ADD CONSTRAINT "User_valid_role"
CHECK ("role" IN ('SUPER_ADMIN', 'MANAGER', 'EXECUTIVE'));
ALTER TABLE "DistributionRule" ADD CONSTRAINT "DistributionRule_valid_mode"
CHECK ("mode" IN ('SINGLE', 'ROUND_ROBIN', 'ALL', 'MANUAL', 'WEIGHTED', 'CAPACITY'));
ALTER TABLE "RuleRecipient" ADD CONSTRAINT "RuleRecipient_valid_weight"
CHECK ("weight" >= 0 AND "weight" <= 100);
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_positive_capacity"
CHECK ("dailyLimit" > 0 AND "capacity" > 0);
