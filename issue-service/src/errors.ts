import { GraphQLError } from "graphql";

export interface InvalidParam {
  name: string;
  reason: string;
}

// GraphQL errors ride in the response body's `errors[]` array over HTTP 200, not a
// distinct HTTP status per error - `extensions.code` is the client-facing signal.
export function notFoundError(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
}

export function conflictError(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "CONFLICT" } });
}

export function badUserInputError(
  message: string,
  invalidParams: InvalidParam[] = [],
): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", invalidParams },
  });
}
