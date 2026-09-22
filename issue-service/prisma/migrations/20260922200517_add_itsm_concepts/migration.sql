-- CreateEnum
CREATE TYPE "IssueKind" AS ENUM ('TASK', 'INCIDENT', 'PROBLEM', 'CHANGE', 'SERVICE_REQUEST');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'MITIGATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('UNDER_INVESTIGATION', 'KNOWN_ERROR', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('STANDARD', 'NORMAL', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'IMPLEMENTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ServiceRequestStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "kind" "IssueKind" NOT NULL DEFAULT 'TASK';

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issue_id" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'SEV3',
    "status" "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "sla_breach_at" TIMESTAMP(3),
    "problem_id" TEXT,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problems" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issue_id" TEXT NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'UNDER_INVESTIGATION',
    "root_cause" VARCHAR(2000),

    CONSTRAINT "problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changes" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issue_id" TEXT NOT NULL,
    "type" "ChangeType" NOT NULL DEFAULT 'NORMAL',
    "status" "ChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "planned_at" TIMESTAMP(3),
    "implemented_at" TIMESTAMP(3),
    "problem_id" TEXT,

    CONSTRAINT "changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issue_id" TEXT NOT NULL,
    "requester_email" VARCHAR(255) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "status" "ServiceRequestStatus" NOT NULL DEFAULT 'NEW',
    "due_at" TIMESTAMP(3),
    "sla_breach_at" TIMESTAMP(3),

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "IssueKind" NOT NULL,
    "severity" "IncidentSeverity",
    "category" VARCHAR(50),
    "response_target_minutes" INTEGER,
    "resolution_target_minutes" INTEGER NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incidents_issue_id_key" ON "incidents"("issue_id");

-- CreateIndex
CREATE INDEX "incidents_status_idx" ON "incidents"("status");

-- CreateIndex
CREATE INDEX "incidents_severity_idx" ON "incidents"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "problems_issue_id_key" ON "problems"("issue_id");

-- CreateIndex
CREATE INDEX "problems_status_idx" ON "problems"("status");

-- CreateIndex
CREATE UNIQUE INDEX "changes_issue_id_key" ON "changes"("issue_id");

-- CreateIndex
CREATE INDEX "changes_status_idx" ON "changes"("status");

-- CreateIndex
CREATE INDEX "changes_type_idx" ON "changes"("type");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_issue_id_key" ON "service_requests"("issue_id");

-- CreateIndex
CREATE INDEX "service_requests_status_idx" ON "service_requests"("status");

-- CreateIndex
CREATE INDEX "service_requests_category_idx" ON "service_requests"("category");

-- CreateIndex
CREATE INDEX "sla_policies_project_id_kind_idx" ON "sla_policies"("project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_project_id_kind_severity_category_key" ON "sla_policies"("project_id", "kind", "severity", "category");

-- CreateIndex
CREATE INDEX "issues_project_id_kind_idx" ON "issues"("project_id", "kind");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
