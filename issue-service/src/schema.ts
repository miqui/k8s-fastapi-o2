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
    issues(status: IssueStatus, first: Int, after: String): IssueConnection!
    labels: [Label!]!
  }

  type Issue implements Node {
    id: ID!
    createdAt: String!
    title: String!
    status: IssueStatus!
    priority: Priority!
    project: Project!
    assignee: String
    labels: [Label!]!
    comments: [Comment!]!
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

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Query {
    workspace(id: ID!): Workspace
    issue(id: ID!): Issue
    issuesByLabel(labelId: ID!): [Issue!]!
  }

  type Mutation {
    createIssue(projectId: ID!, title: String!, priority: Priority!): Issue!
    "Fails with a NOT_FOUND error if the issue does not exist."
    moveIssue(id: ID!, status: IssueStatus!): Issue!
    addComment(issueId: ID!, body: String!, author: String!, parentId: ID): Comment!
    attachLabel(issueId: ID!, labelId: ID!): Issue!
  }
`;
