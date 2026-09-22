import gql from "graphql-tag";

export const typeDefs = gql`
  interface Node {
    id: ID!
    createdAt: String!
  }

  enum IssueStatus {
    BACKLOG
    TODO
    IN_PROGRESS
    IN_REVIEW
    DONE
  }

  enum Priority {
    LOW
    MEDIUM
    HIGH
    URGENT
  }

  """
  What an Issue "is" - a plain TASK, or the base record for one of the
  ITSM/ITIL extension types below (Incident/Problem/Change/ServiceRequest),
  reachable through the matching field on Issue.
  """
  enum IssueKind {
    TASK
    INCIDENT
    PROBLEM
    CHANGE
    SERVICE_REQUEST
  }

  enum IncidentSeverity {
    SEV1
    SEV2
    SEV3
    SEV4
  }

  enum IncidentStatus {
    INVESTIGATING
    MITIGATED
    RESOLVED
    CLOSED
  }

  enum ProblemStatus {
    UNDER_INVESTIGATION
    "A Problem whose root cause is understood but not yet fixed (ITIL's \"Known Error\")."
    KNOWN_ERROR
    RESOLVED
  }

  enum ChangeType {
    STANDARD
    NORMAL
    EMERGENCY
  }

  enum ChangeStatus {
    DRAFT
    PENDING_APPROVAL
    APPROVED
    IMPLEMENTED
    ROLLED_BACK
  }

  enum ServiceRequestStatus {
    NEW
    ACKNOWLEDGED
    IN_PROGRESS
    RESOLVED
    CLOSED
  }

  type Workspace implements Node {
    id: ID!
    createdAt: String!
    name: String!
    projects: [Project!]!
  }

  type Project implements Node {
    id: ID!
    createdAt: String!
    key: String!
    workspace: Workspace!
    issues(status: IssueStatus, kind: IssueKind, first: Int, after: String): IssueConnection!
    labels: [Label!]!
  }

  type Issue implements Node {
    id: ID!
    createdAt: String!
    title: String!
    status: IssueStatus!
    priority: Priority!
    kind: IssueKind!
    project: Project!
    assignee: String
    labels: [Label!]!
    comments: [Comment!]!
    "Non-null only when kind is INCIDENT."
    incident: Incident
    "Non-null only when kind is PROBLEM."
    problem: Problem
    "Non-null only when kind is CHANGE."
    change: Change
    "Non-null only when kind is SERVICE_REQUEST."
    serviceRequest: ServiceRequest
  }

  type Incident implements Node {
    id: ID!
    createdAt: String!
    issue: Issue!
    severity: IncidentSeverity!
    status: IncidentStatus!
    detectedAt: String!
    resolvedAt: String
    "SLA deadline resolved from the matching SlaPolicy at creation time, if any was configured."
    slaBreachAt: String
    problem: Problem
  }

  type Problem implements Node {
    id: ID!
    createdAt: String!
    issue: Issue!
    status: ProblemStatus!
    rootCause: String
    incidents: [Incident!]!
    changes: [Change!]!
  }

  type Change implements Node {
    id: ID!
    createdAt: String!
    issue: Issue!
    type: ChangeType!
    status: ChangeStatus!
    plannedAt: String
    implementedAt: String
    "The Problem this Change resolves, if any."
    problem: Problem
  }

  type ServiceRequest implements Node {
    id: ID!
    createdAt: String!
    issue: Issue!
    requesterEmail: String!
    category: String!
    status: ServiceRequestStatus!
    dueAt: String
    "SLA deadline resolved from the matching SlaPolicy at creation time, if any was configured."
    slaBreachAt: String
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    issues: [Issue!]!
  }

  type Comment implements Node {
    id: ID!
    createdAt: String!
    body: String!
    author: String!
    issue: Issue!
    parent: Comment
    replies: [Comment!]!
  }

  type IssueConnection {
    edges: [IssueEdge!]!
    pageInfo: PageInfo!
  }

  type IssueEdge {
    cursor: String!
    node: Issue!
  }

  type IncidentConnection {
    edges: [IncidentEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type IncidentEdge {
    cursor: String!
    node: Incident!
  }

  type ServiceRequestConnection {
    edges: [ServiceRequestEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ServiceRequestEdge {
    cursor: String!
    node: ServiceRequest!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Query {
    workspace(id: ID!): Workspace
    issue(id: ID!): Issue
    issuesByLabel(labelId: ID!): [Issue!]!
    incident(id: ID!): Incident
    problem(id: ID!): Problem
    change(id: ID!): Change
    serviceRequest(id: ID!): ServiceRequest
    """
    Cross-project severity/SLA triage view - unlike Project.issues(kind: INCIDENT),
    this isn't scoped to a single project's board.
    """
    incidents(
      status: IncidentStatus
      severity: IncidentSeverity
      slaBreached: Boolean
      first: Int
      after: String
    ): IncidentConnection!
    "Cross-project SLA queue - see the note on \`incidents\` above."
    serviceRequests(
      status: ServiceRequestStatus
      slaBreached: Boolean
      first: Int
      after: String
    ): ServiceRequestConnection!
  }

  type Mutation {
    createIssue(projectId: ID!, title: String!, priority: Priority!): Issue!
    "Fails with a NOT_FOUND error if the issue does not exist."
    moveIssue(id: ID!, status: IssueStatus!): Issue!
    addComment(issueId: ID!, body: String!, author: String!, parentId: ID): Comment!
    attachLabel(issueId: ID!, labelId: ID!): Issue!

    createIncident(projectId: ID!, title: String!, severity: IncidentSeverity!): Incident!
    "Fails with a NOT_FOUND error if the incident does not exist."
    moveIncident(id: ID!, status: IncidentStatus!): Incident!
    "Fails with a CONFLICT error if the incident and problem belong to different projects."
    linkIncidentToProblem(incidentId: ID!, problemId: ID!): Incident!

    createProblem(projectId: ID!, title: String!): Problem!
    "Fails with a NOT_FOUND error if the problem does not exist."
    moveProblem(id: ID!, status: ProblemStatus!, rootCause: String): Problem!

    createChange(projectId: ID!, title: String!, type: ChangeType!, plannedAt: String): Change!
    "Fails with a NOT_FOUND error if the change does not exist."
    moveChange(id: ID!, status: ChangeStatus!): Change!
    "Fails with a CONFLICT error if the change and problem belong to different projects."
    linkChangeToProblem(changeId: ID!, problemId: ID!): Change!

    createServiceRequest(
      projectId: ID!
      title: String!
      requesterEmail: String!
      category: String!
    ): ServiceRequest!
    "Fails with a NOT_FOUND error if the service request does not exist."
    moveServiceRequest(id: ID!, status: ServiceRequestStatus!): ServiceRequest!
  }
`;
