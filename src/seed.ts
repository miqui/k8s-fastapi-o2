import { prisma } from "./prisma";

// Mirrors MessageService.seedInitialMessage: pre-populate a sample message (and now
// its author, since Message.author is a required relation) on a fresh deployment.
export async function seedInitialMessage(): Promise<void> {
  const count = await prisma.message.count();
  if (count > 0) return;

  const author = await prisma.author.upsert({
    where: { email: "system@message-service.local" },
    update: {},
    create: { name: "system", email: "system@message-service.local" },
  });

  await prisma.message.create({
    data: {
      title: "Welcome to Kubernetes GraphQL API",
      content: "This is a sample message backed by Prisma and PostgreSQL on a kind cluster.",
      authorId: author.id,
    },
  });
}
