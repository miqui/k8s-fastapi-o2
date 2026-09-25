#!/usr/bin/env bash
set -eo pipefail

CLUSTER_NAME="kind-fastapi-cluster"

echo "=========================================================="
echo " FastAPI + SQLAlchemy + PostgreSQL - Kind Deploy"
echo "=========================================================="

# 1. Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Error: docker is required."; exit 1; }
command -v kind >/dev/null 2>&1 || { echo "Error: kind is required."; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "Error: kubectl is required."; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "Error: helm is required."; exit 1; }
command -v op >/dev/null 2>&1 || { echo "Error: 1Password CLI (op) is required. Install it, then run: op run --env-file=.env -- ./deploy-kind.sh"; exit 1; }

# 1a. Check 1Password CLI readiness. This must run via 'op run --env-file=.env -- ./deploy-kind.sh'
#     so PostgreSQL/Grafana/OpenObserve credentials are real secrets, not the invalid
#     placeholder values baked into k8s/observability/openobserve-values.yaml (that
#     placeholder previously reached OpenObserve unresolved and made it panic on boot,
#     crash-looping for ~20 minutes before helm's --wait timeout aborted the whole script).
echo "=> Checking 1Password CLI readiness..."
op whoami >/dev/null 2>&1 || { echo "Error: 1Password CLI (op) is not signed in. Run 'eval \$(op signin)', then re-run: op run --env-file=.env -- ./deploy-kind.sh"; exit 1; }

REQUIRED_SECRET_VARS=(DB_USER DB_PASSWORD POSTGRES_USER POSTGRES_PASSWORD GF_SECURITY_ADMIN_USER GF_SECURITY_ADMIN_PASSWORD ZO_ROOT_USER_EMAIL ZO_ROOT_USER_PASSWORD DOCKERHUB_USERNAME DOCKERHUB_TOKEN_RO)
MISSING_SECRET_VARS=()
for var in "${REQUIRED_SECRET_VARS[@]}"; do
  [ -n "${!var:-}" ] || MISSING_SECRET_VARS+=("${var}")
done
if [ "${#MISSING_SECRET_VARS[@]}" -gt 0 ]; then
  echo "Error: missing required secret(s): ${MISSING_SECRET_VARS[*]}."
  echo "       This script must be run via: op run --env-file=.env -- ./deploy-kind.sh"
  echo "       (copy .env.example to .env and fill in your op://<vault>/<item>/<field> URIs first)"
  exit 1
fi
echo "=> 1Password CLI is signed in and all required secrets are present."

# 1b. Check that the Git repository the ArgoCD Applications track is reachable. ArgoCD clones it
#     anonymously, so if it doesn't exist (or is private) every Application sits at sync status
#     "Unknown" ("authentication required: Repository not found") and the first-sync waits below
#     time out ~10 minutes into the script. Fail here instead, before creating the cluster.
for app_file in k8s/argocd/application.yaml k8s/argocd/observability-application.yaml k8s/argocd/policies-application.yaml k8s/argocd/trivy-operator-application.yaml; do
  APP_REPO_URL="$(awk '/repoURL:/ {print $2; exit}' "${app_file}")"
  APP_REVISION="$(awk '/targetRevision:/ {print $2; exit}' "${app_file}")"
  echo "=> Checking ${APP_REPO_URL} (${APP_REVISION}) is readable by ArgoCD..."
  if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "${APP_REPO_URL}" "refs/heads/${APP_REVISION}" >/dev/null 2>&1; then
    echo "Error: ${app_file} tracks ${APP_REPO_URL} @ ${APP_REVISION}, but that repository/branch"
    echo "       isn't anonymously readable. Create it as a public repo and push these manifests to"
    echo "       '${APP_REVISION}' (or point repoURL at a repo that exists), then re-run."
    exit 1
  fi
done

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

# 4. Install ArgoCD (the message-service image now comes from Docker Hub, built and
#    pushed by GitHub Actions on push to main - see .github/workflows/ - rather than being built
#    and `kind load`-ed locally).
echo "=> Installing ArgoCD..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# --server-side: the applicationsets CRD is too large for client-side apply's last-applied
# annotation (262144-byte limit), which otherwise fails the install.
kubectl apply --server-side --force-conflicts -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
# argocd-server defaults to redirecting HTTP -> HTTPS with a self-signed cert, which the plain
# HTTP nginx Ingress below can't follow. --insecure makes it serve plain HTTP on its "http"
# service port instead - same trust level as Grafana/OpenObserve/Headlamp on this local cluster.
kubectl patch deployment argocd-server -n argocd --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--insecure"}]'
# argocd-repo-server has no resource requests by default (BestEffort QoS), so under Docker
# Desktop VM CPU/memory pressure its /healthz?full=true handler can occasionally miss the
# liveness probe's 5s timeoutSeconds even though the process itself is fine - see the
# "Diagnosing argocd-repo-server liveness probe failures" section of KUBECTL.md. Loosen the
# probe and give it a CPU/memory request (Burstable QoS) so it isn't starved first.
kubectl patch deployment argocd-repo-server -n argocd --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/timeoutSeconds","value":10},
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/failureThreshold","value":6},
  {"op":"add","path":"/spec/template/spec/containers/0/resources","value":{"requests":{"cpu":"100m","memory":"256Mi"}}}
]'
echo "=> Waiting for ArgoCD to be ready..."
kubectl wait --namespace argocd \
  --for=condition=available deployment/argocd-server deployment/argocd-repo-server \
  --timeout=180s
kubectl rollout status statefulset/argocd-application-controller -n argocd --timeout=180s

# Pinned to a release (unlike ArgoCD's "stable" above): v1.x configures itself via an
# ImageUpdater CRD (k8s/argocd/image-updater.yaml), a breaking change from v0.x's Application
# annotations, and its manifest path has moved between majors.
echo "=> Installing Argo CD Image Updater..."
kubectl apply --server-side --force-conflicts -n argocd -f https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/v1.3.0/config/install.yaml
echo "=> Waiting for Argo CD Image Updater to be ready..."
kubectl wait --namespace argocd \
  --for=condition=available deployment/argocd-image-updater-controller \
  --timeout=120s

# 4a. Read-only Docker Hub credentials for Image Updater to poll tags without hitting the
#     anonymous pull rate limit - deliberately a separate, read-only token from the one CI uses
#     to push (see DOCKERHUB_TOKEN_RO in .env.example). The docker-server must be
#     https://registry-1.docker.io: that's the registry endpoint Image Updater looks up, and a
#     secret keyed on index.docker.io fails with "no valid auth entry".
echo "=> Configuring Argo CD Image Updater's Docker Hub credentials..."
kubectl create secret docker-registry dockerhub-image-updater-creds \
  --namespace argocd \
  --docker-server=https://registry-1.docker.io \
  --docker-username="${DOCKERHUB_USERNAME}" \
  --docker-password="${DOCKERHUB_TOKEN_RO}" \
  --dry-run=client -o yaml | kubectl apply -f -

# 4b. Expose the ArgoCD UI at http://argocd.localhost/
kubectl apply -f k8s/argocd/ingress.yaml

# 4c. Install Kyverno (https://kyverno.io - policy engine; values in k8s/kyverno/kyverno-values.yaml).
#     Installed here, before the observability stack, Headlamp and the ArgoCD Application, so its
#     admission webhooks and the policies.kyverno.io CRDs already exist when the policies in
#     k8s/policies/ are registered. The chart is pinned like OpenObserve/Headlamp below.
echo "=> Installing Kyverno..."
if ! helm repo list | grep -q '^kyverno[[:space:]]'; then
  helm repo add kyverno https://kyverno.github.io/kyverno/
fi
helm repo update kyverno

helm upgrade --install kyverno kyverno/kyverno \
  --version 3.9.1 \
  --namespace kyverno --create-namespace \
  -f k8s/kyverno/kyverno-values.yaml \
  --wait --timeout 240s
# helm --wait covers the controllers; also make sure the CRDs the policies need are usable.
kubectl wait --for=condition=established --timeout=60s \
  crd/validatingpolicies.policies.kyverno.io crd/policyexceptions.policies.kyverno.io

# 5. Register the ArgoCD Application that owns k8s/observability/ (OTel Collector, Prometheus,
#    Grafana + its dashboards, kube-state-metrics, node-exporter, the log collector, their RBAC and
#    the namespace itself) and wait for its first sync. Replaces the direct
#    `kubectl apply -k k8s/observability/`, so a merged dashboard or scrape-config change reaches
#    the cluster through Argo like everything else instead of a hand-run kubectl apply. Like the
#    Applications below it tracks `main`, so k8s/observability/ must exist on main. Waits for
#    Synced (resources applied), not Healthy: the pods can't start until the secrets in 5a exist.
#    OpenObserve (5b) and Headlamp (5c) are Helm installs and stay outside it.
echo "=> Registering the observability ArgoCD Application..."
kubectl apply -f k8s/argocd/observability-application.yaml
echo "=> Waiting for the observability Application's first sync..."
kubectl wait --namespace argocd \
  --for=jsonpath='{.status.sync.status}'=Synced application/observability \
  --timeout=180s

# 5a. Inject observability secrets from environment (via op run)
echo "=> Configuring observability secrets..."
kubectl create secret generic grafana-credentials \
  --namespace observability \
  --from-literal=GF_SECURITY_ADMIN_USER="${GF_SECURITY_ADMIN_USER}" \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="${GF_SECURITY_ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic openobserve-remote-write-credentials \
  --namespace observability \
  --from-literal=password="${ZO_ROOT_USER_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

# 5b. Install OpenObserve (openobserve-standalone chart - single node, not the HA chart).
#     Prometheus (deployed above) remote_writes every scraped series, including the
#     message-service metrics, into it - see k8s/observability/config/prometheus.yml.
echo "=> Installing OpenObserve (openobserve-standalone chart)..."
if ! helm repo list | grep -q '^openobserve[[:space:]]'; then
  helm repo add openobserve https://charts.openobserve.ai
fi
helm repo update openobserve

helm upgrade --install openobserve openobserve/openobserve-standalone \
  --version 0.92.2 \
  --namespace observability \
  -f k8s/observability/openobserve-values.yaml \
  --set "auth.ZO_ROOT_USER_EMAIL=${ZO_ROOT_USER_EMAIL}" \
  --set "auth.ZO_ROOT_USER_PASSWORD=${ZO_ROOT_USER_PASSWORD}" \
  --wait --timeout 180s

# 5c. Install Headlamp (https://headlamp.dev/ - general-purpose Kubernetes dashboard,
#     its own "headlamp" namespace, unrelated to the message-service metrics stack above).
echo "=> Installing Headlamp (Kubernetes dashboard)..."
if ! helm repo list | grep -q '^headlamp[[:space:]]'; then
  helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/
fi
helm repo update headlamp

kubectl create namespace headlamp --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/headlamp/resourcequota.yaml

helm upgrade --install headlamp headlamp/headlamp \
  --version 0.45.0 \
  --namespace headlamp \
  -f k8s/headlamp/headlamp-values.yaml \
  --wait --timeout 120s

# 5d. Register the ArgoCD Application that owns k8s/policies/ (Kyverno policies + exceptions) and
#     wait for its first sync, so the policies exist before step 6 syncs any workload. Argo only
#     waits for the resources to be applied, not for Kyverno to finish loading them into its
#     webhooks - a brief gap, harmless here since the workloads are written to pass them.
#     Like the Application in step 6 it tracks `main`, so k8s/policies/ must exist on main.
echo "=> Registering the Kyverno policies ArgoCD Application..."
kubectl apply -f k8s/argocd/policies-application.yaml
echo "=> Waiting for the policies Application's first sync..."
kubectl wait --namespace argocd \
  --for=jsonpath='{.status.sync.status}'=Synced application/kyverno-policies \
  --timeout=180s

# 5e. Register the ArgoCD Application that installs the Trivy Operator (upstream Helm chart, values
#     from k8s/trivy-operator/ on main - see TRIVY.md). It creates its own trivy-system namespace.
#     Only waits for Synced: the first sync can take a retry or two while the chart's CRDs are
#     established, and the scans themselves (VulnerabilityReports etc.) keep arriving for minutes
#     afterwards - nothing later in this script depends on them. Before step 6 so the API
#     workloads get scanned as soon as they appear.
echo "=> Registering the Trivy Operator ArgoCD Application..."
kubectl apply -f k8s/argocd/trivy-operator-application.yaml
echo "=> Waiting for the Trivy Operator Application's first sync..."
kubectl wait --namespace argocd \
  --for=jsonpath='{.status.sync.status}'=Synced application/trivy-operator \
  --timeout=300s

# 6. Register the ArgoCD Application that owns k8s/ (Postgres, Hazelcast, message-service,
#    Ingress, ResourceQuota - everything k8s/kustomization.yaml produces).
#    ArgoCD's own sync now does what `kubectl apply -k k8s/` used to do directly, and keeps
#    reapplying it (selfHeal) - see k8s/argocd/application.yaml for the postgres-credentials
#    ignoreDifferences caveat that makes that safe alongside step 6a below.
echo "=> Registering the ArgoCD Application and its Image Updater config..."
kubectl apply -f k8s/argocd/application.yaml
kubectl apply -f k8s/argocd/image-updater.yaml
echo "=> Waiting for the ArgoCD Application's first sync..."
kubectl wait --namespace argocd \
  --for=jsonpath='{.status.sync.status}'=Synced application/fastapi-o2 \
  --timeout=180s

# 6a. Inject database secrets from environment (via op run) - real values, overwriting the
#     placeholder k8s/secret.yaml just synced by ArgoCD above.
echo "=> Configuring PostgreSQL database credentials from environment..."
kubectl create secret generic postgres-credentials \
  --namespace default \
  --from-literal=DB_USER="${DB_USER}" \
  --from-literal=DB_PASSWORD="${DB_PASSWORD}" \
  --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

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

# 10. Wait for API rollouts
echo "=> Waiting for Deployments to be ready..."
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
echo " message-service REST API: http://localhost/messages (docs: http://localhost/docs)"
echo " message-service health:   http://localhost/health/liveness"
echo " Grafana:                  http://grafana.localhost/ (credentials from 1Password / Secret)"
echo " OpenObserve:              http://openobserve.localhost/ (credentials from 1Password / Secret)"
echo " Headlamp:                 http://headlamp.localhost/ (login token: kubectl create token headlamp -n headlamp --duration=24h)"
echo " ArgoCD:                   http://argocd.localhost/ (login: admin / kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
echo "=========================================================="
