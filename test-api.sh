#!/usr/bin/env bash
set -eo pipefail

BASE_URL="http://localhost"
GRAPHQL_URL="${BASE_URL}/graphql"

echo "=========================================================="
echo " Testing GraphQL (Apollo Server) + Prisma + PostgreSQL API "
echo " Base URL: ${GRAPHQL_URL}                                  "
echo "=========================================================="

gql() {
  curl -s -X POST "${GRAPHQL_URL}" -H "Content-Type: application/json" -d "$1"
}

echo -e "\n1. Check liveness/readiness:"
curl -s "${BASE_URL}/health/liveness" | jq . || curl -s "${BASE_URL}/health/liveness"
curl -s "${BASE_URL}/health/readiness" | jq . || curl -s "${BASE_URL}/health/readiness"

echo -e "\n\n2. Query all messages:"
gql '{"query":"{ messages(limit: 50, offset: 0) { totalCount items { id title content version author { id name } } } }"}' | jq . \
  || gql '{"query":"{ messages(limit: 50, offset: 0) { totalCount items { id title content version author { id name } } } }"}'

echo -e "\n\n3. Create an author:"
AUTHOR_RESP=$(gql '{"query":"mutation($input: CreateAuthorInput!) { createAuthor(input: $input) { id name email } }","variables":{"input":{"name":"kubernetes-admin","email":"kubernetes-admin@example.com"}}}')
echo "${AUTHOR_RESP}" | jq . || echo "${AUTHOR_RESP}"
AUTHOR_ID=$(echo "${AUTHOR_RESP}" | jq -r '.data.createAuthor.id' 2>/dev/null || true)

echo -e "\n\n4. Create a valid message:"
CREATE_RESP=$(gql "{\"query\":\"mutation(\$input: CreateMessageInput!) { createMessage(input: \$input) { id title content version author { name } } }\",\"variables\":{\"input\":{\"title\":\"Kubernetes Kind Deployment\",\"content\":\"GraphQL + Prisma running on 3 nodes!\",\"authorId\":\"${AUTHOR_ID}\"}}}")
echo "${CREATE_RESP}" | jq . || echo "${CREATE_RESP}"
MSG_ID=$(echo "${CREATE_RESP}" | jq -r '.data.createMessage.id' 2>/dev/null || true)

echo -e "\n\n5. Create an invalid message (expecting a BAD_USER_INPUT GraphQL error):"
gql '{"query":"mutation($input: CreateMessageInput!) { createMessage(input: $input) { id } }","variables":{"input":{"title":"","content":"","authorId":""}}}' | jq . \
  || gql '{"query":"mutation($input: CreateMessageInput!) { createMessage(input: $input) { id } }","variables":{"input":{"title":"","content":"","authorId":""}}}'

if [ -n "${MSG_ID}" ] && [ "${MSG_ID}" != "null" ]; then
  echo -e "\n\n6. Query message by ID (${MSG_ID}):"
  gql "{\"query\":\"{ message(id: \\\"${MSG_ID}\\\") { id title content version author { name } } }\"}" | jq . \
    || gql "{\"query\":\"{ message(id: \\\"${MSG_ID}\\\") { id title content version author { name } } }\"}"

  echo -e "\n\n7. Update message (${MSG_ID}), version 0:"
  gql "{\"query\":\"mutation(\$id: ID!, \$input: UpdateMessageInput!) { updateMessage(id: \$id, input: \$input) { id title content version } }\",\"variables\":{\"id\":\"${MSG_ID}\",\"input\":{\"title\":\"Updated Title\",\"content\":\"Updated content for kind 3-node cluster\",\"version\":0}}}" | jq . \
    || gql "{\"query\":\"mutation(\$id: ID!, \$input: UpdateMessageInput!) { updateMessage(id: \$id, input: \$input) { id title content version } }\",\"variables\":{\"id\":\"${MSG_ID}\",\"input\":{\"title\":\"Updated Title\",\"content\":\"Updated content for kind 3-node cluster\",\"version\":0}}}"

  echo -e "\n\n8. Update message again with a stale version (expecting a CONFLICT GraphQL error):"
  gql "{\"query\":\"mutation(\$id: ID!, \$input: UpdateMessageInput!) { updateMessage(id: \$id, input: \$input) { id version } }\",\"variables\":{\"id\":\"${MSG_ID}\",\"input\":{\"content\":\"Stale write\",\"version\":0}}}" | jq . \
    || gql "{\"query\":\"mutation(\$id: ID!, \$input: UpdateMessageInput!) { updateMessage(id: \$id, input: \$input) { id version } }\",\"variables\":{\"id\":\"${MSG_ID}\",\"input\":{\"content\":\"Stale write\",\"version\":0}}}"

  echo -e "\n\n9. Delete message (${MSG_ID}):"
  gql "{\"query\":\"mutation(\$id: ID!) { deleteMessage(id: \$id) }\",\"variables\":{\"id\":\"${MSG_ID}\"}}" | jq . \
    || gql "{\"query\":\"mutation(\$id: ID!) { deleteMessage(id: \$id) }\",\"variables\":{\"id\":\"${MSG_ID}\"}}"
fi

if [ -n "${AUTHOR_ID}" ] && [ "${AUTHOR_ID}" != "null" ]; then
  echo -e "\n\n10. Delete author (${AUTHOR_ID}), now that its message is gone:"
  gql "{\"query\":\"mutation(\$id: ID!) { deleteAuthor(id: \$id) }\",\"variables\":{\"id\":\"${AUTHOR_ID}\"}}" | jq . \
    || gql "{\"query\":\"mutation(\$id: ID!) { deleteAuthor(id: \$id) }\",\"variables\":{\"id\":\"${AUTHOR_ID}\"}}"
fi

echo -e "\n\n=========================================================="
echo " API Verification Completed!                               "
echo "=========================================================="
