// Query depth and complexity limits - see GRAPHQL-API-DESIGN.md for the rationale, the cost
// model, and how the limits were calibrated against EXAMPLES.md. Enforced in a plugin rather
// than validationRules because validation runs before variables are coerced (so `first: $n`
// would be priced at the default page size) and Apollo relabels validation errors, which would
// lose the QUERY_TOO_DEEP / QUERY_TOO_COMPLEX codes that graphql_errors_total is labelled by.
import type { ApolloServerPlugin } from "@apollo/server";
import { GraphQLError, Kind } from "graphql";
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from "graphql";
import { fieldExtensionsEstimator, getComplexity } from "graphql-query-complexity";
import type { ComplexityEstimator } from "graphql-query-complexity";

export const MAX_DEPTH = 10;
export const MAX_COMPLEXITY = 5000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const UNBOUNDED_LIST_ESTIMATE = 10;

// Field-nesting depth of the operation, following fragment spreads. __typename and
// introspection fields are free so the Sandbox keeps working.
function operationDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  memo = new Map<string, number>(),
  visiting = new Set<string>(),
): number {
  let deepest = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith("__")) continue;
      const below = selection.selectionSet
        ? operationDepth(selection.selectionSet, fragments, memo, visiting)
        : 0;
      deepest = Math.max(deepest, 1 + below);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, operationDepth(selection.selectionSet, fragments, memo, visiting));
    } else {
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (!fragment || visiting.has(name)) continue; // cycles are rejected by graphql-js's own rules
      if (!memo.has(name)) {
        visiting.add(name);
        memo.set(name, operationDepth(fragment.selectionSet, fragments, memo, visiting));
        visiting.delete(name);
      }
      deepest = Math.max(deepest, memo.get(name) ?? 0);
    }
  }
  return deepest;
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }
  return fragments;
}

// cost(field) = 1 + cost(children) * multiplier
//   paginated field (has a `limit` arg): clamped `limit`, or the default page size
//   `items` on a *Page:                  1 (the parent's `limit` already bounds it)
//   any other list field:                UNBOUNDED_LIST_ESTIMATE (drop once the list is capped)
//   everything else:                     1
const costEstimator: ComplexityEstimator = ({ type, field, args, childComplexity }) => {
  if (field.name === "items" && type.name.endsWith("Page")) return 1 + childComplexity;
  let multiplier = 1;
  if (field.args.some((arg) => arg.name === "limit")) {
    multiplier = Math.min(Math.max(Number(args.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  } else if (String(field.type).includes("[")) {
    multiplier = UNBOUNDED_LIST_ESTIMATE;
  }
  return 1 + childComplexity * multiplier;
};

function reject(message: string, code: "QUERY_TOO_DEEP" | "QUERY_TOO_COMPLEX"): never {
  throw new GraphQLError(message, { extensions: { code, http: { status: 400 } } });
}

// A plugin rather than validationRules: validation runs before variables are coerced, so
// `first: $n` would be priced at the default page size; didResolveOperation has them.
export const queryLimitsPlugin: ApolloServerPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ request, document, operation, schema }) {
        if (!operation) return;
        const depth = operationDepth(operation.selectionSet, fragmentsOf(document));
        if (depth > MAX_DEPTH) reject(`Query depth ${depth} exceeds the maximum of ${MAX_DEPTH}.`, "QUERY_TOO_DEEP");

        const complexity = getComplexity({
          schema,
          query: document,
          variables: request.variables,
          operationName: request.operationName,
          estimators: [fieldExtensionsEstimator(), costEstimator],
        });
        if (complexity > MAX_COMPLEXITY) {
          reject(`Query complexity ${complexity} exceeds the maximum of ${MAX_COMPLEXITY}.`, "QUERY_TOO_COMPLEX");
        }
      },
    };
  },
};
