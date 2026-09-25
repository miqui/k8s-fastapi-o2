# Kyverno policy review

A point-in-time review of the Kyverno policies in [`k8s/policies/`](k8s/policies/) as deployed to
the local kind cluster (`kind-kind-fastapi-cluster`). See [KYVERNO.md](KYVERNO.md) for how the
policies are structured and applied; this document only records what the review found and what is
recommended as follow-up. Nothing here has been implemented.

Reviewed against Kyverno v1.19.1 (chart 3.9.1), the version
[`deploy-kind.sh`](deploy-kind.sh) installs and [`check-policies.sh`](check-policies.sh) evaluates
with.

## What is deployed today

Ten `ValidatingPolicy` objects (the CEL-based `policies.kyverno.io/v1` types - no deprecated
`ClusterPolicy` remains), all reporting `Ready`.

| Scope | Policies | Action | `failurePolicy` |
| --- | --- | --- | --- |
| `default` | `disallow-host-access`, `require-secure-container-context`, `require-resources`, `restrict-image-repositories` (`-enforce`) | Deny | `Fail` (chart default) |
| `observability`, `headlamp` | the same four (`-audit`) | Audit | `Ignore` |
| `default`, `observability`, `headlamp` | `disallow-latest-tag` | Audit | `Ignore` |
| cluster-wide | `restrict-cluster-admin-bindings` | Audit | `Ignore` |

Three `PolicyException`s (`node-exporter`, `log-collector`, `headlamp-admin`) live in the `kyverno`
namespace, as required by `features.policyExceptions.namespace` in
[`k8s/kyverno/kyverno-values.yaml`](k8s/kyverno/kyverno-values.yaml).

### Current report state

- `default` - 8 PolicyReports, **0 failures**. All five policies that cover the namespace are
  represented, so the enforce set is genuinely evaluating, not silently matching nothing.
- `observability` / `headlamp` - 13 workloads failing, every one of them
  `require-secure-container-context-audit`, across three distinct messages: missing
  `runAsNonRoot`, missing `allowPrivilegeEscalation: false`, and no `RuntimeDefault`/`Localhost`
  seccomp profile. Affected: `grafana`, `prometheus`, `otel-collector`, `kube-state-metrics`,
  `openobserve`, `openobserve-blocked-metrics`, `headlamp`.
- Cluster-scoped - `restrict-cluster-admin-bindings`: 20 pass, 1 skip (the `headlamp-admin`
  exception), 0 fail.

### What the review found working well

- Shared rule bodies under `rules/` with kustomize overlays supplying scope and Deny/Audit, so the
  enforce and audit copies cannot drift apart.
- `autogen.podControllers` on every pod-scoped policy, so violations surface when the Deployment or
  StatefulSet is applied rather than as downstream ReplicaSet events.
- `failurePolicy: Ignore` on *every* audit-only policy - an unreachable Kyverno cannot block a
  namespace that the policy was never allowed to deny in.
- A webhook-level `namespaceSelector` in the Helm values excluding `kube-system`, `argocd`,
  `ingress-nginx` and `local-path-storage`, independent of any individual policy's scope.
- `reportsController.rbac.clusterRole.extraResources` granting the reports controller access to
  `clusterrolebindings` - without it `restrict-cluster-admin-bindings` produces no background scan
  results at all, which is easy to miss because admission-time auditing keeps working.
- CI parity: [`check-policies.sh`](check-policies.sh) runs the same policies against the repo's
  manifests, refuses to pass vacuously (it asserts rules were loaded and at least one evaluation
  passed), and self-tests the enforce set against a known-bad fixture.

## Recommendations

Ordered by priority. Each is independent.

### High

#### 1. Cover the `pods/ephemeralcontainers` subresource

Every pod-scoped policy matches `resources: ["pods"]`. In Kubernetes, `pods/ephemeralcontainers` is
a *separate* subresource, so it is not covered by that rule. The practical effect is that
`kubectl debug` can attach a privileged, root, `hostPath`-mounting ephemeral container to an
otherwise fully hardened pod in the `default` namespace without any policy evaluating it.

Add `pods/ephemeralcontainers` to `matchConstraints.resourceRules` in
[`rules/disallow-host-access.yaml`](k8s/policies/rules/disallow-host-access.yaml) and
[`rules/require-secure-container-context.yaml`](k8s/policies/rules/require-secure-container-context.yaml).
Note that the object sent for that subresource is still the full Pod, but the `containers` variable
should be extended with `object.spec.?ephemeralContainers.orValue([])` so the injected container is
actually inspected.

#### 2. Label namespaces for Pod Security Admission

No namespace carries any `pod-security.kubernetes.io/*` label. Kyverno is therefore the *only*
control enforcing the Pod Security Standards, and it is a single-replica admission controller whose
webhook deliberately skips four namespaces.

Add PSA labels as defense-in-depth - built into the API server, so they hold even when Kyverno is
unavailable, and they cost nothing at runtime:

- `default`: `pod-security.kubernetes.io/enforce: restricted`
- `observability`: `pod-security.kubernetes.io/enforce: baseline` plus
  `pod-security.kubernetes.io/audit: restricted` (the namespace has 13 restricted-level violations
  today, so `restricted` cannot be enforced yet - see recommendation 11)

`node-exporter` and `log-collector` need `baseline` exemptions of their own; PSA has no per-workload
exception mechanism, so either isolate them in their own namespace or leave `observability` at
`audit`/`warn` only.

#### 3. Extend audit coverage to `argocd`, `kyverno` and `trivy-system`

These three namespaces run 8, 4 and 2 workloads respectively and are matched by **no policy at all**
- not even Audit. Argo CD in particular is the cluster's write path: anything it can be made to sync
is unreviewed by the policy engine.

Add them to the `namespaceSelector` in
[`overlays/audit-other/kustomization.yaml`](k8s/policies/overlays/audit-other/kustomization.yaml)
and to `disallow-latest-tag`. This is report-only and `failurePolicy: Ignore`, so it cannot break
anything; expect new findings and new entries in `restrict-image-repositories`' allowlist. Note the
webhook `namespaceSelector` in `kyverno-values.yaml` excludes `argocd` from *admission* - background
scanning still reports on it, which is the intent here.

### Medium

#### 4. Add `jobs` and `cronjobs` to `autogen.podControllers`

The autogen list is `["deployments", "statefulsets", "daemonsets"]`. A violating CronJob is
therefore admitted cleanly and only rejected later, when the controller tries to create the pod -
the failure appears as a Job event rather than as a rejected `kubectl apply`, which is exactly the
late-failure mode the autogen block was added to avoid. `trivy-system` already runs Jobs
(`node-collector`), and `ingress-nginx` uses admission Jobs.

#### 5. Promote `disallow-latest-tag` to the enforce set for `default`

The policy is audit-only because `k8s/kustomization.yaml` shipped `newTag: latest` as the bootstrap
fallback and denying `:latest` would have blocked the first sync. That condition no longer holds -
`default` is currently running `docker.io/miqui/rest-message-api:20260925151209-d23a94a`, a
timestamped tag from Argo CD Image Updater.

Move it into [`overlays/enforce-default`](k8s/policies/overlays/enforce-default/kustomization.yaml)
(keeping an audit copy for the other namespaces), which is the promotion the file's own header
comment anticipates. Confirm the bootstrap path no longer needs `:latest` before doing so, or a
cluster rebuild from scratch will fail its first sync.

#### 6. Verify image provenance, not just the repository

`restrict-image-repositories` pins the *repository* but deliberately ignores the tag and digest, and
nothing verifies signatures. Any tag pushed to `docker.io/miqui/rest-message-api` is accepted,
including one pushed by someone who obtained the Docker Hub credentials.

Add an `ImageValidatingPolicy` (`policies.kyverno.io/v1`) doing keyless cosign verification for the
repo's own image - the GitHub Actions workflow that builds it can sign it with the workflow
identity. As a cheaper interim step, require digest references (`@sha256:...`) for the
first-party image.

#### 7. Require `readOnlyRootFilesystem`

`require-secure-container-context` covers `runAsNonRoot`, `allowPrivilegeEscalation`, `drop: ALL`
and seccomp, but not `readOnlyRootFilesystem`. The repo's own `default`-namespace workloads already
set it, so adding the validation is free there and would only produce (useful) audit findings
elsewhere.

#### 8. Split `require-secure-container-context` so exceptions can be narrower

`PolicyException`s apply to a whole policy, not a single `validations` entry. `log-collector` needs
a waiver for `runAsNonRoot` only (it reads root-owned `/var/log/pods`), but the current exception
waives the entire policy - silently giving up the `allowPrivilegeEscalation`, `drop: ALL` and
seccomp checks for that DaemonSet even though it satisfies all three. `node-exporter` has the same
problem.

Splitting the four validations into four policies (or at least separating `runAsNonRoot` from the
rest) restores those checks. The trade-off is four policy objects instead of one and a longer
`policyRefs` list in each exception.

### Low

#### 9. Tighten `require-resources`

Two additions worth considering:

- Validate `limits >= requests` per container. Today a container can request 2Gi and limit 256Mi,
  which passes the policy and is immediately OOM-killed.
- Reconsider requiring a CPU *limit*. CPU limits cause CFS throttling and are widely regarded as an
  anti-pattern for latency-sensitive services; requiring CPU *requests* plus memory requests and
  limits is the more common recommendation. This is a deliberate-choice question, not a defect.

#### 10. Decide explicitly about the single-replica admission controller

The enforce policies run with the default `failurePolicy: Fail` against a single
`kyverno-admission-controller` replica (the chart's HA guidance is 2-3; the values file documents
one replica as an intentional choice for a disposable cluster). The consequence is that a Kyverno
outage blocks *all* writes to the `default` namespace, including the Argo CD sync that would repair
it. `kyverno-cleanup-controller` and `kyverno-reports-controller` have both restarted on this
cluster already.

Either raise the admission controller to 2 replicas, or record the accepted recovery procedure
(delete the `ValidatingWebhookConfiguration`, or scale Kyverno back up) in `KYVERNO.md`. Do not
switch the enforce policies to `Ignore` - that would make them fail open, which defeats the point.

#### 11. Give the 13 standing audit failures an owner or an exception

The `observability`/`headlamp` violations are real restricted-PSS gaps that have been tolerated
indefinitely with no tracked decision. While they persist, "any new failure" is not a usable signal
because the baseline is already non-zero.

Either harden the `observability` securityContexts (most of these charts and manifests support it)
or convert the accepted ones into explicit `PolicyException`s with a comment explaining why, the way
`node-exporter` and `log-collector` already are. Headlamp is a third-party chart and is the most
likely genuine exception.

#### 12. Prune the image allowlist

`docker.io/library/busybox`, `docker.io/library/nginx` and `docker.io/curlimages/curl` are on the
allowlist shared by the enforce and audit copies. If they are not actually used by a workload in a
covered namespace, removing them narrows what can be started in `default` - these three are exactly
the images a debug or exfiltration container would use.

#### 13. Optional: mutate instead of deny, and generate network policies

Not gaps, just capability that is unused:

- A `MutatingPolicy` could inject `seccompProfile: RuntimeDefault` and
  `allowPrivilegeEscalation: false` defaults rather than rejecting manifests that omit them, which
  is often a better experience for third-party charts than an exception.
- A `GeneratingPolicy` could create a default-deny `NetworkPolicy` in each covered namespace.
- A `CleanupPolicy` could remove completed Jobs (the kind `ingress-nginx` and `trivy-system` leave
  behind).

## Summary

The highest-value items are **1** (a real bypass of the enforce set via ephemeral containers),
**2** (no enforcement fallback if Kyverno is unavailable) and **3** (Argo CD, the cluster's write
path, is entirely unreviewed).
