import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { evictCachedMessage, getCachedMessage, setCachedMessage } from "./cache";
import { badUserInputError, conflictError, InvalidParam, notFoundError } from "./errors";
import {
  optionalEmail,
  optionalSized,
  requireEmail,
  requireNonBlank,
  throwIfInvalid,
} from "./validation";

const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

type SerializedAuthor = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

type SerializedMessage = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  version: number;
  author: SerializedAuthor;
};

function serializeAuthor(author: {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}): SerializedAuthor {
  return {
    id: author.id,
    name: author.name,
    email: author.email,
    createdAt: author.createdAt.toISOString(),
  };
}

function serializeMessage(message: {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  version: number;
  author: { id: string; name: string; email: string; createdAt: Date };
}): SerializedMessage {
  return {
    id: message.id,
    title: message.title,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    version: message.version,
    author: serializeAuthor(message.author),
  };
}

function clampPagination(limit: number, offset: number): void {
  const errors: InvalidParam[] = [];
  if (limit < MIN_LIMIT) errors.push({ name: "limit", reason: "limit must be at least 1" });
  if (limit > MAX_LIMIT) errors.push({ name: "limit", reason: "limit must not exceed 200" });
  if (offset < 0) errors.push({ name: "offset", reason: "offset must not be negative" });
  throwIfInvalid(errors);
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isForeignKeyConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

async function getMessageById(id: string): Promise<SerializedMessage> {
  const cached = await getCachedMessage<SerializedMessage>(id);
  if (cached) return cached;

  const message = await prisma.message.findUnique({ where: { id }, include: { author: true } });
  if (!message) {
    throw notFoundError(`Message with ID '${id}' was not found.`);
  }

  const serialized = serializeMessage(message);
  await setCachedMessage(id, serialized);
  return serialized;
}

export const resolvers = {
  Query: {
    async messages(_: unknown, args: { limit?: number; offset?: number }) {
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      clampPagination(limit, offset);

      const [items, totalCount] = await Promise.all([
        prisma.message.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
          include: { author: true },
        }),
        prisma.message.count(),
      ]);

      return { items: items.map(serializeMessage), totalCount };
    },

    async message(_: unknown, args: { id: string }) {
      return getMessageById(args.id);
    },

    async authors() {
      const list = await prisma.author.findMany({ orderBy: { createdAt: "asc" } });
      return list.map(serializeAuthor);
    },

    async author(_: unknown, args: { id: string }) {
      const found = await prisma.author.findUnique({ where: { id: args.id } });
      if (!found) throw notFoundError(`Author with ID '${args.id}' was not found.`);
      return serializeAuthor(found);
    },
  },

  Mutation: {
    async createMessage(
      _: unknown,
      args: { input: { title: string; content: string; authorId: string } },
    ) {
      const errors: InvalidParam[] = [];
      const title = requireNonBlank(args.input.title, "title", 100, errors);
      const content = requireNonBlank(args.input.content, "content", 1000, errors);
      const authorId = requireNonBlank(args.input.authorId, "authorId", 100, errors);
      throwIfInvalid(errors);

      const author = await prisma.author.findUnique({ where: { id: authorId } });
      if (!author) throw notFoundError(`Author with ID '${authorId}' was not found.`);

      const created = await prisma.message.create({
        data: { title, content, authorId },
        include: { author: true },
      });
      return serializeMessage(created);
    },

    async updateMessage(
      _: unknown,
      args: { id: string; input: { title?: string; content: string; version: number } },
    ) {
      const errors: InvalidParam[] = [];
      const content = requireNonBlank(args.input.content, "content", 1000, errors);
      const title = optionalSized(args.input.title, "title", 100, errors);
      throwIfInvalid(errors);

      // Guard against args.input.version - what the caller actually read - not a
      // server-side re-read, which would just check the row against itself and never
      // catch a client acting on stale data. Same optimistic-locking rationale as the
      // old MessageMapper.xml's `WHERE id = ? AND version = ?`.
      const existing = await getMessageById(args.id);
      const result = await prisma.message.updateMany({
        where: { id: args.id, version: args.input.version },
        data: {
          title: title && title.length > 0 ? title : existing.title,
          content,
          version: { increment: 1 },
        },
      });

      await evictCachedMessage(args.id);

      if (result.count === 0) {
        throw conflictError(
          `Message with ID '${args.id}' has changed since version ${args.input.version} was read; refetch and retry.`,
        );
      }

      const updated = await prisma.message.findUniqueOrThrow({
        where: { id: args.id },
        include: { author: true },
      });
      const serialized = serializeMessage(updated);
      await setCachedMessage(args.id, serialized);
      return serialized;
    },

    async deleteMessage(_: unknown, args: { id: string }) {
      const result = await prisma.message.deleteMany({ where: { id: args.id } });
      await evictCachedMessage(args.id);
      if (result.count === 0) {
        throw notFoundError(`Message with ID '${args.id}' was not found.`);
      }
      return true;
    },

    async createAuthor(_: unknown, args: { input: { name: string; email: string } }) {
      const errors: InvalidParam[] = [];
      const name = requireNonBlank(args.input.name, "name", 50, errors);
      const email = requireEmail(args.input.email, "email", 100, errors);
      throwIfInvalid(errors);

      try {
        const created = await prisma.author.create({ data: { name, email } });
        return serializeAuthor(created);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw badUserInputError(`Author with email '${email}' already exists.`, [
            { name: "email", reason: "email must be unique" },
          ]);
        }
        throw err;
      }
    },

    async updateAuthor(
      _: unknown,
      args: { id: string; input: { name?: string; email?: string } },
    ) {
      const errors: InvalidParam[] = [];
      const name = optionalSized(args.input.name, "name", 50, errors);
      const email = optionalEmail(args.input.email, "email", 100, errors);
      throwIfInvalid(errors);

      const existing = await prisma.author.findUnique({ where: { id: args.id } });
      if (!existing) throw notFoundError(`Author with ID '${args.id}' was not found.`);

      try {
        const updated = await prisma.author.update({
          where: { id: args.id },
          data: {
            name: name && name.length > 0 ? name : undefined,
            email: email && email.length > 0 ? email : undefined,
          },
        });
        return serializeAuthor(updated);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw badUserInputError(`Author with email '${email}' already exists.`, [
            { name: "email", reason: "email must be unique" },
          ]);
        }
        throw err;
      }
    },

    async deleteAuthor(_: unknown, args: { id: string }) {
      try {
        const result = await prisma.author.deleteMany({ where: { id: args.id } });
        if (result.count === 0) throw notFoundError(`Author with ID '${args.id}' was not found.`);
        return true;
      } catch (err) {
        if (isForeignKeyConstraintError(err)) {
          throw conflictError(
            `Author with ID '${args.id}' still has messages and cannot be deleted.`,
          );
        }
        throw err;
      }
    },
  },

  Author: {
    async messages(parent: { id: string }) {
      const list = await prisma.message.findMany({
        where: { authorId: parent.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { author: true },
      });
      return list.map(serializeMessage);
    },
  },
};
