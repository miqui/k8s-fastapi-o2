import { prisma } from "./prisma";

// Pre-populate a sample workspace/project/issue on a fresh deployment, mirroring
// message-service's seedInitialMessage.
export async function seedInitialIssue(): Promise<void> {
  const count = await prisma.workspace.count();
  if (count > 0) return;

  const workspace = await prisma.workspace.create({
    data: { name: "Default Workspace" },
  });

  const project = await prisma.project.create({
    data: { key: "ENG", workspaceId: workspace.id },
  });

  await prisma.issue.create({
    data: {
      title: "Welcome to the issue tracker",
      status: "TODO",
      priority: "MEDIUM",
      projectId: project.id,
    },
  });
}
