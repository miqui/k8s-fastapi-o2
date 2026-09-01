#!/usr/bin/env bash
set -eo pipefail

BASE_URL="http://localhost"

echo "=========================================================="
echo " Testing Spring Boot 4 + MyBatis + PostgreSQL API          "
echo " Base URL: ${BASE_URL}                                   "
echo "=========================================================="

echo -e "\n1. Check Actuator Health & Probes:"
curl -s "${BASE_URL}/actuator/health" | jq . || curl -s "${BASE_URL}/actuator/health"

echo -e "\n\n2. GET all messages:"
curl -s "${BASE_URL}/api/messages" | jq . || curl -s "${BASE_URL}/api/messages"

echo -e "\n\n3. POST create valid message:"
CREATE_RESP=$(curl -s -X POST "${BASE_URL}/api/messages" \
  -H "Content-Type: application/json" \
  -d '{"title":"Kubernetes Kind Deployment","content":"Spring Boot 4 running on 2 nodes!","sender":"kubernetes-admin"}')
echo "${CREATE_RESP}" | jq . || echo "${CREATE_RESP}"

MSG_ID=$(echo "${CREATE_RESP}" | grep -o '"id":"[^"]*' | cut -d'"' -f4 || true)

echo -e "\n4. POST invalid message (Expecting 400 Bad Request with RFC 9457 Problem Details):"
curl -s -i -X POST "${BASE_URL}/api/messages" \
  -H "Content-Type: application/json" \
  -d '{"title":"","content":"","sender":""}'

if [ -n "${MSG_ID}" ]; then
  echo -e "\n\n5. GET message by ID (${MSG_ID}):"
  curl -s "${BASE_URL}/api/messages/${MSG_ID}" | jq . || curl -s "${BASE_URL}/api/messages/${MSG_ID}"

  echo -e "\n\n6. PUT update message (${MSG_ID}):"
  curl -s -X PUT "${BASE_URL}/api/messages/${MSG_ID}" \
    -H "Content-Type: application/json" \
    -d '{"title":"Updated Title","content":"Updated content for kind 2-node cluster"}' | jq .

  echo -e "\n\n7. DELETE message (${MSG_ID}):"
  curl -s -i -X DELETE "${BASE_URL}/api/messages/${MSG_ID}"
fi

echo -e "\n\n=========================================================="
echo " API Verification Completed!                               "
echo "=========================================================="
