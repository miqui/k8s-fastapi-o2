import gql from "graphql-tag";

export const typeDefs = gql`
  type Author {
    id: ID!
    name: String!
    email: String!
    createdAt: String!
    messages: [Message!]!
  }

  type Message {
    id: ID!
    title: String!
    content: String!
    author: Author!
    createdAt: String!
    version: Int!
  }

  """
  Mirrors the old PagedResult<T> / X-Total-Count response header: \`items\` is the
  requested page, \`totalCount\` is the full row count independent of limit/offset.
  """
  type MessagePage {
    items: [Message!]!
    totalCount: Int!
  }

  input CreateMessageInput {
    title: String!
    content: String!
    authorId: ID!
  }

  """
  No authorId here - the old REST API never allowed changing the sender on update
  either, so authorship stays fixed at creation time.
  """
  input UpdateMessageInput {
    title: String
    content: String!
    version: Int!
  }

  input CreateAuthorInput {
    name: String!
    email: String!
  }

  input UpdateAuthorInput {
    name: String
    email: String
  }

  type Query {
    "limit defaults to 50 (1-200), offset defaults to 0 (>=0) - same bounds as the old REST API."
    messages(limit: Int = 50, offset: Int = 0): MessagePage!
    message(id: ID!): Message
    authors: [Author!]!
    author(id: ID!): Author
  }

  type Mutation {
    createMessage(input: CreateMessageInput!): Message!
    "Fails with a CONFLICT error if \`input.version\` no longer matches the stored row."
    updateMessage(id: ID!, input: UpdateMessageInput!): Message!
    deleteMessage(id: ID!): Boolean!
    createAuthor(input: CreateAuthorInput!): Author!
    updateAuthor(id: ID!, input: UpdateAuthorInput!): Author!
    "Fails with a CONFLICT error if the author still has messages."
    deleteAuthor(id: ID!): Boolean!
  }
`;
