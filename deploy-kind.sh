#!/usr/bin/env bash
set -eo pipefail

CLUSTER_NAME="kind-graphql-prisma-cluster"
IMAGE_NAME="message-service:latest"

echo "=========================================================="
echo " GraphQL (Apollo Server) + Prisma + PostgreSQL - Kind Deploy"
echo "=========================================================="

# 1. Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Error: docker is required."; exit 1; }
command -v kind >/dev/null 2>&1 || { echo "Error: kind is required."; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "Error: kubectl is required."; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "Error: helm is required."; exit 1; }

# 2. Check / Create Kind cluster (1 control-plane, 2 API workers, 1 DB worker,
#    1 observability worker, 1 cache worker, 1 OpenObserve worker)
if kind get clusters | grep -q "^${CLUSTER_NAME}$"; then
  echo "=> Kind cluster '${CLUSTER_NAME}' already exists."
else
  echo "=> Creating Kind cluster '${CLUSTER_NAME}'..."
  kind create cluster --name "${CLUSTER_NAME}" --config k8s/kind-config.yaml
fi

# Ensure kubectl context points to kind cluster
kubectl config use-context "kind-${CLUSTER_NAME}"

# 3. Install the ingress-nginx controller (binds host ports 80/443 via kind-config.yaml)
echo "=> Installing ingress-nginx controller..."
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml
echo "=> Waiting for ingress-nginx controller to be ready..."
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s

# 3a. Install metrics-server (required for the message-service HorizontalPodAutoscaler to read
#     CPU/memory usage; not preinstalled on kind, and needs --kubelet-insecure-tls since kind's
#     kubelet serving certs aren't signed for metrics-server's default verification).
echo "=> Installing metrics-server..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
echo "=> Waiting for metrics-server to be ready..."
kubectl wait --namespace kube-system \
  --for=condition=available deployment/metrics-server \
  --timeout=120s

# 4. Build Docker image
echo "=> Building Docker image '${IMAGE_NAME}'..."
docker build -t "${IMAGE_NAME}" .

# 5. Load Docker image into kind nodes
echo "=> Loading '${IMAGE_NAME}' into kind cluster..."
kind load docker-image "${IMAGE_NAME}" --name "${CLUSTER_NAME}"

# 6. Apply the observability stack (OTel Collector, Prometheus, Grafana, OpenObserve)
echo "=> Applying observability stack manifests..."
kubectl apply -k k8s/observability/

# 6a. Inject observability secrets from environment (e.g. op run)
echo "=> Configuring observability secrets..."
if [ -n "${GF_SECURITY_ADMIN_USER:-}" ] || [ -n "${GF_SECURITY_ADMIN_PASSWORD:-}" ]; then
  kubectl create secret generic grafana-credentials \
    --namespace observability \
    --from-literal=GF_SECURITY_ADMIN_USER="${GF_SECURITY_ADMIN_USER:-${GF_ADMIN_USER:-admin}}" \
    --from-literal=GF_SECURITY_ADMIN_PASSWORD="${GF_SECURITY_ADMIN_PASSWORD:-${GF_ADMIN_PASSWORD:-admin}}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

if [ -n "${ZO_ROOT_USER_PASSWORD:-}" ] || [ -n "${ZO_PASSWORD:-}" ]; then
  kubectl create secret generic openobserve-remote-write-credentials \
    --namespace observability \
    --from-literal=password="${ZO_ROOT_USER_PASSWORD:-${ZO_PASSWORD:-YOUR_OPENOBSERVE_ROOT_PASSWORD}}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# 6b. Install OpenObserve (openobserve-standalone chart - single node, not the HA chart).
#     Prometheus (deployed above) remote_writes every scraped series, including the
#     message-service metrics, into it - see k8s/observability/prometheus-configmap.yaml.
echo "=> Installing OpenObserve (openobserve-standalone chart)..."
if ! helm repo list | grep -q '^openobserve[[:space:]]'; then
  helm repo add openobserve https://charts.openobserve.ai
fi
helm repo update openobserve

HELM_AUTH_ARGS=()
if [ -n "${ZO_ROOT_USER_EMAIL:-}" ] || [ -n "${ZO_EMAIL:-}" ]; then
  HELM_AUTH_ARGS+=(--set "auth.ZO_ROOT_USER_EMAIL=${ZO_ROOT_USER_EMAIL:-${ZO_EMAIL:-YOUR_OPENOBSERVE_ROOT_EMAIL}}")
fi
if [ -n "${ZO_ROOT_USER_PASSWORD:-}" ] || [ -n "${ZO_PASSWORD:-}" ]; then
  HELM_AUTH_ARGS+=(--set "auth.ZO_ROOT_USER_PASSWORD=${ZO_ROOT_USER_PASSWORD:-${ZO_PASSWORD:-YOUR_OPENOBSERVE_ROOT_PASSWORD}}")
fi

helm upgrade --install openobserve openobserve/openobserve-standalone \
  --version 0.92.2 \
  --namespace observability \
  -f k8s/observability/openobserve-values.yaml \
  "${HELM_AUTH_ARGS[@]}" \
  --wait --timeout 180s

# 6c. Install Headlamp (https://headlamp.dev/ - general-purpose Kubernetes dashboard,
#     its own "headlamp" namespace, unrelated to the message-service metrics stack above).
echo "=> Installing Headlamp (Kubernetes dashboard)..."
if ! helm repo list | grep -q '^headlamp[[:space:]]'; then
  helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/
fi
helm repo update headlamp

helm upgrade --install headlamp headlamp/headlamp \
  --version 0.45.0 \
  --namespace headlamp \
  --create-namespace \
  -f k8s/headlamp/headlamp-values.yaml \
  --wait --timeout 120s

# 7. Apply Kubernetes manifests
echo "=> Applying Kubernetes manifests..."
kubectl apply -k k8s/

# 7a. Inject database secrets from environment (e.g. op run)
if [ -n "${DB_USER:-}" ] || [ -n "${DB_PASSWORD:-}" ] || [ -n "${POSTGRES_USER:-}" ] || [ -n "${POSTGRES_PASSWORD:-}" ]; then
  echo "=> Configuring PostgreSQL database credentials from environment..."
  kubectl create secret generic postgres-credentials \
    --namespace default \
    --from-literal=DB_USER="${DB_USER:-YOUR_POSTGRES_DB_USER}" \
    --from-literal=DB_PASSWORD="${DB_PASSWORD:-YOUR_POSTGRES_DB_PASSWORD}" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER:-${DB_USER:-YOUR_POSTGRES_USER}}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-${DB_PASSWORD:-YOUR_POSTGRES_PASSWORD}}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# 8. Wait for PostgreSQL and Hazelcast to be ready before the API rolls out
echo "=> Waiting for PostgreSQL StatefulSet to be ready..."
kubectl rollout status statefulset/postgres --timeout=120s
echo "=> Waiting for Hazelcast to be ready..."
kubectl rollout status deployment/hazelcast --timeout=120s

# 9. Wait for the observability stack to be ready
echo "=> Waiting for observability stack to be ready..."
kubectl rollout status deployment/otel-collector -n observability --timeout=120s
kubectl rollout status deployment/prometheus -n observability --timeout=120s
kubectl rollout status deployment/grafana -n observability --timeout=120s
kubectl rollout status statefulset/openobserve -n observability --timeout=180s
kubectl rollout status deployment/headlamp -n headlamp --timeout=120s

# 10. Wait for API rollout
echo "=> Waiting for Deployment to be ready..."
kubectl rollout status deployment/message-service --timeout=180s

# 11. Cluster & Pod overview
echo ""
echo "==================== Cluster Nodes ===================="
kubectl get nodes -L workload -o wide
echo ""
echo "==================== PostgreSQL Pod ====================="
kubectl get pods -l app=postgres -o wide
echo ""
echo "==================== Hazelcast Pod ======================="
kubectl get pods -l app=hazelcast -o wide
echo ""
echo "==================== Application Pods ==================="
kubectl get pods -l app=message-service -o wide
echo ""
echo "==================== Application Service ================"
kubectl get svc message-service
echo ""
echo "==================== Observability Pods ================="
kubectl get pods -n observability -o wide
echo ""
echo "==================== Headlamp Pod ========================"
kubectl get pods -n headlamp -o wide

echo ""
echo "=========================================================="
echo " GraphQL endpoint:         http://localhost/graphql"
echo " Health:                   http://localhost/health/liveness"
echo " Grafana:                  http://grafana.localhost/ (credentials from 1Password / Secret)"
echo " OpenObserve:              http://openobserve.localhost/ (credentials from 1Password / Secret)"
echo " Headlamp:                 http://headlamp.localhost/ (login token: kubectl create token headlamp -n headlamp --duration=24h)"
echo "=========================================================="
