import type {
  ChangeStatus,
  ChangeType,
  IncidentSeverity,
  IncidentStatus,
  IssueKind,
  Prisma,
  ProblemStatus,
  ServiceRequestStatus,
} from "@prisma/client";
import { prisma } from "./prisma";
import { badUserInputError, conflictError, InvalidParam, notFoundError } from "./errors";
import { optionalSized, requireNonBlank, throwIfInvalid } from "./validation";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Statuses that count as "still open" for slaBreached filtering - an Incident or
// ServiceRequest already RESOLVED/CLOSED can't be in breach any more even if its
// slaBreachAt has passed.
const OPEN_INCIDENT_STATUSES: IncidentStatus[] = ["INVESTIGATING", "MITIGATED"];
const OPEN_SERVICE_REQUEST_STATUSES: ServiceRequestStatus[] = [
  "NEW",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
];

function iso(date: Date): string {
  return date.toISOString();
}

function isoOrNull(date: Date | null): string | null {
  return date ? iso(date) : null;
}

// Opaque keyset-pagination cursor over (createdAt, id) - stable across pages even
// when new rows are created concurrently, unlike an offset that shifts under you.
// Shared across every connection below (Issue/Incident/ServiceRequest all sort
// the same way), so the cursor format and its clamping/decoding logic live here once.
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64").toString("utf8");
  const separatorIndex = raw.indexOf("|");
  if (separatorIndex === -1) {
    throw badUserInputError("The 'after' cursor is malformed.", [
      { name: "after", reason: "cursor could not be decoded" },
    ]);
  }
  const createdAt = new Date(raw.slice(0, separatorIndex));
  const id = raw.slice(separatorIndex + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw badUserInputError("The 'after' cursor is malformed.", [
      { name: "after", reason: "cursor could not be decoded" },
    ]);
  }
  return { createdAt, id };
}

function clampFirst(first?: number | null): number {
  return Math.min(Math.max(first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

// AND's the caller's filters with the keyset cursor condition, if any - kept
// generic so it works the same way whether `where` is an IssueWhereInput,
// IncidentWhereInput, or ServiceRequestWhereInput.
function cursorWhere<W extends object>(where: W, after?: string | null): W {
  if (!after) return where;
  const cursor = decodeCursor(after);
  return {
    AND: [
      where,
      {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
    ],
  } as unknown as W;
}

function buildPage<T extends { createdAt: Date; id: string }>(items: T[], take: number) {
  const hasNextPage = items.length > take;
  const page = hasNextPage ? items.slice(0, take) : items;
  const lastItem = page[page.length - 1];

  return {
    edges: page.map((item) => ({ cursor: encodeCursor(item.createdAt, item.id), node: item })),
    pageInfo: {
      hasNextPage,
      endCursor: lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null,
    },
  };
}

async function issueConnection(
  where: Prisma.IssueWhereInput,
  first?: number | null,
  after?: string | null,
) {
  const take = clampFirst(first);
  const items = await prisma.issue.findMany({
    where: cursorWhere(where, after),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
  });
  return buildPage(items, take);
}

async function incidentConnection(
  where: Prisma.IncidentWhereInput,
  first?: number | null,
  after?: string | null,
) {
  const take = clampFirst(first);
  const [items, totalCount] = await Promise.all([
    prisma.incident.findMany({
      where: cursorWhere(where, after),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: take + 1,
    }),
    prisma.incident.count({ where }),
  ]);
  return { ...buildPage(items, take), totalCount };
}

async function serviceRequestConnection(
  where: Prisma.ServiceRequestWhereInput,
  first?: number | null,
  after?: string | null,
) {
  const take = clampFirst(first);
  const [items, totalCount] = await Promise.all([
    prisma.serviceRequest.findMany({
      where: cursorWhere(where, after),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: take + 1,
    }),
    prisma.serviceRequest.count({ where }),
  ]);
  return { ...buildPage(items, take), totalCount };
}

// Looks up the one matching SlaPolicy row (per project + kind + severity/category)
// and turns its resolution target into an absolute deadline. Seed-only table - see
// schema.prisma - so this is a plain exact-match lookup with no fallback/default
// tier; a project with no policy configured just gets a null slaBreachAt.
async function resolveSlaBreachAt(
  projectId: string,
  kind: "INCIDENT" | "SERVICE_REQUEST",
  criteria: { severity?: string | null; category?: string | null },
): Promise<Date | null> {
  const policy = await prisma.slaPolicy.findFirst({
    where: {
      projectId,
      kind,
      severity: (criteria.severity ?? null) as IncidentSeverity | null,
      category: criteria.category ?? null,
    },
  });
  if (!policy) return null;
  return new Date(Date.now() + policy.resolutionTargetMinutes * 60_000);
}

export const resolvers = {
  Query: {
    async workspace(_: unknown, args: { id: string }) {
      return prisma.workspace.findUnique({ where: { id: args.id } });
    },

    async issue(_: unknown, args: { id: string }) {
      return prisma.issue.findUnique({ where: { id: args.id } });
    },

    async issuesByLabel(_: unknown, args: { labelId: string }) {
      return prisma.issue.findMany({
        where: { labels: { some: { id: args.labelId } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    },

    async incident(_: unknown, args: { id: string }) {
      return prisma.incident.findUnique({ where: { id: args.id } });
    },

    async problem(_: unknown, args: { id: string }) {
      return prisma.problem.findUnique({ where: { id: args.id } });
    },

    async change(_: unknown, args: { id: string }) {
      return prisma.change.findUnique({ where: { id: args.id } });
    },

    async serviceRequest(_: unknown, args: { id: string }) {
      return prisma.serviceRequest.findUnique({ where: { id: args.id } });
    },

    async incidents(
      _: unknown,
      args: {
        status?: IncidentStatus;
        severity?: IncidentSeverity;
        slaBreached?: boolean;
        first?: number;
        after?: string;
      },
    ) {
      const conditions: Prisma.IncidentWhereInput[] = [];
      if (args.status) conditions.push({ status: args.status });
      if (args.severity) conditions.push({ severity: args.severity });
      if (args.slaBreached) {
        conditions.push({ slaBreachAt: { lt: new Date() } });
        conditions.push({ status: { in: OPEN_INCIDENT_STATUSES } });
      }
      const where: Prisma.IncidentWhereInput = conditions.length ? { AND: conditions } : {};
      return incidentConnection(where, args.first, args.after);
    },

    async serviceRequests(
      _: unknown,
      args: {
        status?: ServiceRequestStatus;
        slaBreached?: boolean;
        first?: number;
        after?: string;
      },
    ) {
      const conditions: Prisma.ServiceRequestWhereInput[] = [];
      if (args.status) conditions.push({ status: args.status });
      if (args.slaBreached) {
        conditions.push({ slaBreachAt: { lt: new Date() } });
        conditions.push({ status: { in: OPEN_SERVICE_REQUEST_STATUSES } });
      }
      const where: Prisma.ServiceRequestWhereInput = conditions.length ? { AND: conditions } : {};
      return serviceRequestConnection(where, args.first, args.after);
    },
  },

  Mutation: {
    async createIssue(
      _: unknown,
      args: { projectId: string; title: string; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT" },
    ) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.title, "title", 200, errors);
      throwIfInvalid(errors);

      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFoundError(`Project with ID '${args.projectId}' was not found.`);

      return prisma.issue.create({
        data: { projectId: args.projectId, title, priority: args.priority },
      });
    },

    async moveIssue(
      _: unknown,
      args: { id: string; status: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" },
    ) {
      const existing = await prisma.issue.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`Issue with ID '${args.id}' was not found.`);

      return prisma.issue.update({ where: { id: args.id }, data: { status: args.status } });
    },

    async addComment(
      _: unknown,
      args: { issueId: string; body: string; author: string; parentId?: string | null },
    ) {
      const errors: InvalidParam[] = [];
      const body = requireNonBlank(args.body, "body", 2000, errors);
      const author = requireNonBlank(args.author, "author", 100, errors);
      throwIfInvalid(errors);

      const issue = await prisma.issue.findUnique({ where: { id: args.issueId } });
      if (!issue) throw notFoundError(`Issue with ID '${args.issueId}' was not found.`);

      if (args.parentId) {
        const parent = await prisma.comment.findUnique({ where: { id: args.parentId } });
        if (!parent) throw notFoundError(`Comment with ID '${args.parentId}' was not found.`);
        if (parent.issueId !== args.issueId) {
          throw conflictError(
            `Comment with ID '${args.parentId}' belongs to a different issue than '${args.issueId}'.`,
          );
        }
      }

      return prisma.comment.create({
        data: {
          issueId: args.issueId,
          body,
          author,
          parentId: args.parentId ?? null,
        },
      });
    },

    async attachLabel(_: unknown, args: { issueId: string; labelId: string }) {
      const [issue, label] = await Promise.all([
        prisma.issue.findUnique({ where: { id: args.issueId } }),
        prisma.label.findUnique({ where: { id: args.labelId } }),
      ]);
      if (!issue) throw notFoundError(`Issue with ID '${args.issueId}' was not found.`);
      if (!label) throw notFoundError(`Label with ID '${args.labelId}' was not found.`);
      if (label.projectId !== issue.projectId) {
        throw conflictError(
          `Label with ID '${args.labelId}' belongs to a different project than issue '${args.issueId}'.`,
        );
      }

      return prisma.issue.update({
        where: { id: args.issueId },
        data: { labels: { connect: { id: args.labelId } } },
      });
    },

    async createIncident(
      _: unknown,
      args: { projectId: string; title: string; severity: IncidentSeverity },
    ) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.title, "title", 200, errors);
      throwIfInvalid(errors);

      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFoundError(`Project with ID '${args.projectId}' was not found.`);

      const slaBreachAt = await resolveSlaBreachAt(args.projectId, "INCIDENT", {
        severity: args.severity,
      });

      return prisma.$transaction(async (tx) => {
        const issue = await tx.issue.create({
          data: { projectId: args.projectId, title, kind: "INCIDENT" },
        });
        return tx.incident.create({
          data: { issueId: issue.id, severity: args.severity, slaBreachAt },
        });
      });
    },

    async moveIncident(_: unknown, args: { id: string; status: IncidentStatus }) {
      const existing = await prisma.incident.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`Incident with ID '${args.id}' was not found.`);

      const closing = args.status === "RESOLVED" || args.status === "CLOSED";
      return prisma.incident.update({
        where: { id: args.id },
        data: {
          status: args.status,
          resolvedAt: closing ? (existing.resolvedAt ?? new Date()) : existing.resolvedAt,
        },
      });
    },

    async linkIncidentToProblem(_: unknown, args: { incidentId: string; problemId: string }) {
      const [incident, problem] = await Promise.all([
        prisma.incident.findUnique({ where: { id: args.incidentId }, include: { issue: true } }),
        prisma.problem.findUnique({ where: { id: args.problemId }, include: { issue: true } }),
      ]);
      if (!incident) throw notFoundError(`Incident with ID '${args.incidentId}' was not found.`);
      if (!problem) throw notFoundError(`Problem with ID '${args.problemId}' was not found.`);
      if (incident.issue.projectId !== problem.issue.projectId) {
        throw conflictError(
          `Incident '${args.incidentId}' and Problem '${args.problemId}' belong to different projects.`,
        );
      }

      return prisma.incident.update({
        where: { id: args.incidentId },
        data: { problemId: args.problemId },
      });
    },

    async createProblem(_: unknown, args: { projectId: string; title: string }) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.title, "title", 200, errors);
      throwIfInvalid(errors);

      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFoundError(`Project with ID '${args.projectId}' was not found.`);

      return prisma.$transaction(async (tx) => {
        const issue = await tx.issue.create({
          data: { projectId: args.projectId, title, kind: "PROBLEM" },
        });
        return tx.problem.create({ data: { issueId: issue.id } });
      });
    },

    async moveProblem(
      _: unknown,
      args: { id: string; status: ProblemStatus; rootCause?: string },
    ) {
      const existing = await prisma.problem.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`Problem with ID '${args.id}' was not found.`);

      const errors: InvalidParam[] = [];
      const rootCause = optionalSized(args.rootCause, "rootCause", 2000, errors);
      throwIfInvalid(errors);

      return prisma.problem.update({
        where: { id: args.id },
        data: { status: args.status, rootCause: rootCause ?? existing.rootCause },
      });
    },

    async createChange(
      _: unknown,
      args: { projectId: string; title: string; type: ChangeType; plannedAt?: string },
    ) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.title, "title", 200, errors);
      throwIfInvalid(errors);

      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFoundError(`Project with ID '${args.projectId}' was not found.`);

      return prisma.$transaction(async (tx) => {
        const issue = await tx.issue.create({
          data: { projectId: args.projectId, title, kind: "CHANGE" },
        });
        return tx.change.create({
          data: {
            issueId: issue.id,
            type: args.type,
            plannedAt: args.plannedAt ? new Date(args.plannedAt) : null,
          },
        });
      });
    },

    async moveChange(_: unknown, args: { id: string; status: ChangeStatus }) {
      const existing = await prisma.change.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`Change with ID '${args.id}' was not found.`);

      const implemented = args.status === "IMPLEMENTED";
      return prisma.change.update({
        where: { id: args.id },
        data: {
          status: args.status,
          implementedAt: implemented
            ? (existing.implementedAt ?? new Date())
            : existing.implementedAt,
        },
      });
    },

    async linkChangeToProblem(_: unknown, args: { changeId: string; problemId: string }) {
      const [change, problem] = await Promise.all([
        prisma.change.findUnique({ where: { id: args.changeId }, include: { issue: true } }),
        prisma.problem.findUnique({ where: { id: args.problemId }, include: { issue: true } }),
      ]);
      if (!change) throw notFoundError(`Change with ID '${args.changeId}' was not found.`);
      if (!problem) throw notFoundError(`Problem with ID '${args.problemId}' was not found.`);
      if (change.issue.projectId !== problem.issue.projectId) {
        throw conflictError(
          `Change '${args.changeId}' and Problem '${args.problemId}' belong to different projects.`,
        );
      }

      return prisma.change.update({
        where: { id: args.changeId },
        data: { problemId: args.problemId },
      });
    },

    async createServiceRequest(
      _: unknown,
      args: { projectId: string; title: string; requesterEmail: string; category: string },
    ) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.title, "title", 200, errors);
      const requesterEmail = requireNonBlank(args.requesterEmail, "requesterEmail", 255, errors);
      const category = requireNonBlank(args.category, "category", 50, errors);
      throwIfInvalid(errors);

      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFoundError(`Project with ID '${args.projectId}' was not found.`);

      const slaBreachAt = await resolveSlaBreachAt(args.projectId, "SERVICE_REQUEST", {
        category,
      });

      return prisma.$transaction(async (tx) => {
        const issue = await tx.issue.create({
          data: { projectId: args.projectId, title, kind: "SERVICE_REQUEST" },
        });
        return tx.serviceRequest.create({
          data: { issueId: issue.id, requesterEmail, category, slaBreachAt },
        });
      });
    },

    async moveServiceRequest(
      _: unknown,
      args: { id: string; status: ServiceRequestStatus },
    ) {
      const existing = await prisma.serviceRequest.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`ServiceRequest with ID '${args.id}' was not found.`);

      return prisma.serviceRequest.update({ where: { id: args.id }, data: { status: args.status } });
    },
  },

  Workspace: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    async projects(parent: { id: string }) {
      return prisma.project.findMany({ where: { workspaceId: parent.id }, orderBy: { createdAt: "asc" } });
    },
  },

  Project: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    async workspace(parent: { workspaceId: string }) {
      return prisma.workspace.findUniqueOrThrow({ where: { id: parent.workspaceId } });
    },
    async issues(
      parent: { id: string },
      args: {
        status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
        kind?: IssueKind;
        first?: number;
        after?: string;
      },
    ) {
      return issueConnection(
        {
          projectId: parent.id,
          ...(args.status ? { status: args.status } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
        },
        args.first,
        args.after,
      );
    },
    async labels(parent: { id: string }) {
      return prisma.label.findMany({ where: { projectId: parent.id }, orderBy: { name: "asc" } });
    },
  },

  Issue: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    async project(parent: { projectId: string }) {
      return prisma.project.findUniqueOrThrow({ where: { id: parent.projectId } });
    },
    async labels(parent: { id: string }) {
      return prisma.label.findMany({ where: { issues: { some: { id: parent.id } } }, orderBy: { name: "asc" } });
    },
    async comments(parent: { id: string }) {
      // Top-level comments only - Comment.replies resolves the thread underneath each.
      return prisma.comment.findMany({
        where: { issueId: parent.id, parentId: null },
        orderBy: { createdAt: "asc" },
      });
    },
    async incident(parent: { id: string }) {
      return prisma.incident.findUnique({ where: { issueId: parent.id } });
    },
    async problem(parent: { id: string }) {
      return prisma.problem.findUnique({ where: { issueId: parent.id } });
    },
    async change(parent: { id: string }) {
      return prisma.change.findUnique({ where: { issueId: parent.id } });
    },
    async serviceRequest(parent: { id: string }) {
      return prisma.serviceRequest.findUnique({ where: { issueId: parent.id } });
    },
  },

  Incident: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    detectedAt: (parent: { detectedAt: Date }) => iso(parent.detectedAt),
    resolvedAt: (parent: { resolvedAt: Date | null }) => isoOrNull(parent.resolvedAt),
    slaBreachAt: (parent: { slaBreachAt: Date | null }) => isoOrNull(parent.slaBreachAt),
    async issue(parent: { issueId: string }) {
      return prisma.issue.findUniqueOrThrow({ where: { id: parent.issueId } });
    },
    async problem(parent: { problemId: string | null }) {
      if (!parent.problemId) return null;
      return prisma.problem.findUnique({ where: { id: parent.problemId } });
    },
  },

  Problem: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    async issue(parent: { issueId: string }) {
      return prisma.issue.findUniqueOrThrow({ where: { id: parent.issueId } });
    },
    async incidents(parent: { id: string }) {
      return prisma.incident.findMany({ where: { problemId: parent.id }, orderBy: { createdAt: "asc" } });
    },
    async changes(parent: { id: string }) {
      return prisma.change.findMany({ where: { problemId: parent.id }, orderBy: { createdAt: "asc" } });
    },
  },

  Change: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    plannedAt: (parent: { plannedAt: Date | null }) => isoOrNull(parent.plannedAt),
    implementedAt: (parent: { implementedAt: Date | null }) => isoOrNull(parent.implementedAt),
    async issue(parent: { issueId: string }) {
      return prisma.issue.findUniqueOrThrow({ where: { id: parent.issueId } });
    },
    async problem(parent: { problemId: string | null }) {
      if (!parent.problemId) return null;
      return prisma.problem.findUnique({ where: { id: parent.problemId } });
    },
  },

  ServiceRequest: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    dueAt: (parent: { dueAt: Date | null }) => isoOrNull(parent.dueAt),
    slaBreachAt: (parent: { slaBreachAt: Date | null }) => isoOrNull(parent.slaBreachAt),
    async issue(parent: { issueId: string }) {
      return prisma.issue.findUniqueOrThrow({ where: { id: parent.issueId } });
    },
  },

  Label: {
    async issues(parent: { id: string }) {
      return prisma.issue.findMany({
        where: { labels: { some: { id: parent.id } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    },
  },

  Comment: {
    createdAt: (parent: { createdAt: Date }) => iso(parent.createdAt),
    async issue(parent: { issueId: string }) {
      return prisma.issue.findUniqueOrThrow({ where: { id: parent.issueId } });
    },
    async parent(parent: { parentId: string | null }) {
      if (!parent.parentId) return null;
      return prisma.comment.findUnique({ where: { id: parent.parentId } });
    },
    async replies(parent: { id: string }) {
      return prisma.comment.findMany({ where: { parentId: parent.id }, orderBy: { createdAt: "asc" } });
    },
  },
};
