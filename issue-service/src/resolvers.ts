import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { badUserInputError, conflictError, InvalidParam, notFoundError } from "./errors";
import { requireNonBlank, throwIfInvalid } from "./validation";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function iso(date: Date): string {
  return date.toISOString();
}

// Opaque keyset-pagination cursor over (createdAt, id) - stable across pages even
// when new issues are created concurrently, unlike an offset that shifts under you.
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

async function issueConnection(
  where: Prisma.IssueWhereInput,
  first?: number | null,
  after?: string | null,
) {
  const take = Math.min(Math.max(first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = after ? decodeCursor(after) : undefined;

  const items = await prisma.issue.findMany({
    where: cursor
      ? {
          AND: [
            where,
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
  });

  const hasNextPage = items.length > take;
  const page = hasNextPage ? items.slice(0, take) : items;
  const lastItem = page[page.length - 1];

  return {
    edges: page.map((issue) => ({ cursor: encodeCursor(issue.createdAt, issue.id), node: issue })),
    pageInfo: {
      hasNextPage,
      endCursor: lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null,
    },
  };
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
      args: { status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE"; first?: number; after?: string },
    ) {
      return issueConnection(
        { projectId: parent.id, ...(args.status ? { status: args.status } : {}) },
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
