#!/usr/bin/env bash
set -eo pipefail

CLUSTER_NAME="kind-springboot-mybatis-cluster"

echo "Deleting Kind cluster '${CLUSTER_NAME}'..."
kind delete cluster --name "${CLUSTER_NAME}"
echo "Cluster deleted."
