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

  // SlaPolicy has no GraphQL mutation - it's seed-only (see schema.prisma) - so
  // this is the only place these targets are ever set. One row per Incident
  // severity plus a couple of ServiceRequest categories, just enough for
  // createIncident/createServiceRequest to resolve a non-null slaBreachAt.
  await prisma.slaPolicy.createMany({
    data: [
      { projectId: project.id, kind: "INCIDENT", severity: "SEV1", responseTargetMinutes: 5, resolutionTargetMinutes: 60 },
      { projectId: project.id, kind: "INCIDENT", severity: "SEV2", responseTargetMinutes: 15, resolutionTargetMinutes: 240 },
      { projectId: project.id, kind: "INCIDENT", severity: "SEV3", responseTargetMinutes: 60, resolutionTargetMinutes: 1440 },
      { projectId: project.id, kind: "INCIDENT", severity: "SEV4", responseTargetMinutes: 240, resolutionTargetMinutes: 4320 },
      { projectId: project.id, kind: "SERVICE_REQUEST", category: "hardware", resolutionTargetMinutes: 2880 },
      { projectId: project.id, kind: "SERVICE_REQUEST", category: "access", resolutionTargetMinutes: 480 },
    ],
  });
}
