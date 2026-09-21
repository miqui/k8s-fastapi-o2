# ArgoCD — commands & troubleshooting

Day-to-day ArgoCD commands for this repo's local kind cluster. Everything is `kubectl`-based: the
`argocd` CLI isn't installed here (an optional CLI section is at the end). For the design — what
ArgoCD owns and why — see the "Continuous Deployment with ArgoCD" section of `README.md`; for
`argocd-repo-server` liveness-probe failures see `KUBECTL.md`.

Commands marked ✅ were run against this cluster while writing this; the rest are standard ArgoCD /
kubectl usage that I did not run here.

## What's in the cluster

| Thing | Name | Defined in |
| :--- | :--- | :--- |
| Application: `default` namespace (Postgres, Hazelcast, both APIs, Ingress, quotas) | `graphql-apollo-prisma-o2` | `k8s/argocd/application.yaml`, syncs `k8s/` |
| Application: Kyverno policies + PolicyExceptions | `kyverno-policies` | `k8s/argocd/policies-application.yaml`, syncs `k8s/policies/` |
| Image Updater config | `ImageUpdater/graphql-apollo-prisma-o2` | `k8s/argocd/image-updater.yaml` |
| UI | `http://argocd.localhost/` | `k8s/argocd/ingress.yaml` |

Both Applications track `main` with `automated: {prune: true, selfHeal: true}`. **Not** managed by
ArgoCD: `k8s/observability/` (applied by `deploy-kind.sh` with `kubectl apply -k`), Headlamp, and
Kyverno itself.

ArgoCD components in the `argocd` namespace: `argocd-server`, `argocd-repo-server`,
`argocd-redis`, `argocd-dex-server`, `argocd-applicationset-controller`,
`argocd-notifications-controller`, `argocd-image-updater-controller` (Deployments) and
`argocd-application-controller` (StatefulSet).

## Status

```bash
kubectl get applications -n argocd                                                       # ✅ sync + health at a glance

# one Application: sync status, health, deployed commit, last operation
kubectl get application graphql-apollo-prisma-o2 -n argocd \
  -o jsonpath='{.status.sync.status} {.status.health.status} rev={.status.sync.revision} {.status.operationState.phase}{"\n"}'   # ✅

# per-resource status (spot the OutOfSync / Degraded one)
kubectl get application graphql-apollo-prisma-o2 -n argocd \
  -o jsonpath='{range .status.resources[*]}{.kind}/{.name} {.status} {.health.status}{"\n"}{end}'                              # ✅

# errors (ComparisonError, SyncError, ...) - empty output means none
kubectl get application graphql-apollo-prisma-o2 -n argocd -o jsonpath='{.status.conditions}{"\n"}'                          # ✅

# last deployments: id, commit, time
kubectl get application graphql-apollo-prisma-o2 -n argocd \
  -o jsonpath='{range .status.history[-3:]}{.id} {.revision} {.deployedAt}{"\n"}{end}'                                        # ✅

kubectl describe application graphql-apollo-prisma-o2 -n argocd                          # everything above plus events
```

Compare the deployed commit with `main`: `git rev-parse origin/main` vs `.status.sync.revision`. A
merge is only live once these match — ArgoCD polls git roughly every 3 minutes, so right after a
merge it is normal for the Application to still show the previous commit.

**Health `Progressing`** right after a merge is usually just a rolling update in flight
(`kubectl rollout status deploy/message-service`); it goes back to `Healthy` on its own.

## Forcing a refresh or a sync (without the CLI)

Both of these **modify the live Application object**, so they are worth doing on purpose rather than
by reflex; waiting for the next poll is always the no-touch option.

```bash
# Re-poll git now (ArgoCD removes the annotation itself once handled). "hard" also drops the
# manifest cache - use it if a refresh keeps returning stale state.
kubectl annotate application kyverno-policies -n argocd argocd.argoproj.io/refresh=normal --overwrite
kubectl annotate application kyverno-policies -n argocd argocd.argoproj.io/refresh=hard --overwrite

# Trigger a sync operation (what the UI's "Sync" button does)
kubectl patch application graphql-apollo-prisma-o2 -n argocd --type merge \
  -p '{"operation":{"sync":{"prune":true}}}'
```

With `automated` sync on, a refresh alone is normally enough: once ArgoCD sees the new commit it
syncs by itself.

## Image Updater

CI pushes `docker.io/miqui/<service>:<yyyymmddHHMMSS>-<sha7>`; Image Updater picks the newest tag
(`alphabetical` strategy) roughly every 2 minutes and writes it into the Application — **no git
commit is made**.

```bash
# the tag each service is currently pinned to (the override lives on the Application, not in git)
kubectl get application graphql-apollo-prisma-o2 -n argocd \
  -o jsonpath='{.spec.source.kustomize.images}{"\n"}'                                     # ✅

kubectl get imageupdater -n argocd                                                        # ✅ READY, LAST CHECKED
kubectl logs -n argocd deploy/argocd-image-updater-controller --tail=20                   # ✅
kubectl logs -n argocd deploy/argocd-image-updater-controller | grep 'images_updated'     # ✅ per-cycle summary
```

A healthy idle cycle logs `images_considered=2 images_skipped=0 images_updated=0 errors=0`. To
confirm a rollout picked up a build, compare the tag above with the pods':

```bash
kubectl get pods -n default -l 'app in (message-service,issue-service)' \
  -o jsonpath='{range .items[*]}{.metadata.name} {.spec.containers[0].image}{"\n"}{end}'  # ✅
```

Image tags end in the short SHA of the commit that was built, so `…-3755170` is the build of merge
commit `3755170`.

## Pausing auto-sync (local testing only)

`selfHeal` reverts hand edits to anything ArgoCD owns within minutes, and Image Updater keeps
moving the image tags. To test a locally built image or a hand-patched ConfigMap you must pause
auto-sync first — and remember to restore it.

```bash
# pause: remove the automated block (manual sync still works)
kubectl patch application graphql-apollo-prisma-o2 -n argocd --type json \
  -p '[{"op":"remove","path":"/spec/syncPolicy/automated"}]'

# restore
kubectl patch application graphql-apollo-prisma-o2 -n argocd --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
```

While paused, `kubectl get application …` will show `OutOfSync` for anything you changed by hand.

## Drift you should expect

`postgres-credentials` is a committed placeholder (`k8s/secret.yaml`) that `deploy-kind.sh`
overwrites with real values. `application.yaml` tells ArgoCD to ignore that Secret's data
(`ignoreDifferences` + `RespectIgnoreDifferences=true`), so it never shows as `OutOfSync` and a sync
never puts the placeholder back.

## Rolling back

With `automated` sync enabled ArgoCD refuses `argocd app rollback`. The GitOps way is to
`git revert` the bad merge and let ArgoCD sync `main`. For an emergency image rollback, pause
auto-sync (above) and set the previous tag from `.status.history`, or revert and merge — Image
Updater will otherwise move the tag forward again.

## Troubleshooting

**`ComparisonError` / sync status `Unknown`.** ArgoCD can't render the manifests, so it can't say
whether anything is in sync. Seen live on `kyverno-policies` (2026-09-21):

```
Failed to load target state: failed to generate manifest for source 1 of 1: rpc error:
code = Unavailable desc = dns: A record lookup error: lookup argocd-repo-server on 10.96.0.10:53:
dial udp 10.96.0.10:53: i/o timeout
```

That is the application-controller failing to reach `argocd-repo-server` — the repo-server had just
been restarted by its liveness probe (5 restarts at the time). It is transient: it clears on the
next reconcile once the repo-server is back, and the fix for the restarts themselves is in
`KUBECTL.md` ("Diagnosing `argocd-repo-server` liveness probe failures").

```bash
kubectl get pod -n argocd -l app.kubernetes.io/name=argocd-repo-server        # ✅ RESTARTS column
kubectl logs -n argocd deploy/argocd-repo-server --since=10m | grep '"level":"error"'   # ✅
kubectl logs -n argocd statefulset/argocd-application-controller --since=10m            # sync/compare decisions
kubectl get events -n argocd --sort-by=.lastTimestamp
```

**Merged but nothing changed.** In order: is `.status.sync.revision` the merge commit yet (poll
delay, or a `ComparisonError` above)? Is the change under `k8s/` at all — `k8s/observability/` is
**not** synced and must be applied by hand? For a new image: did CI push it, and does the
Image Updater log show `images_updated=1`?

**Stuck `Progressing` / `Degraded`.** Find the resource with the per-resource query above, then
debug that resource (`kubectl describe`, `kubectl get events`). A Deployment rejected by Kyverno in
`default` shows up here as a sync error naming the policy.

**Sync fails on a policy.** The enforce policies deny non-compliant workloads in `default` when
ArgoCD applies them — see the "Working with the policies" section of `README.md` and `KYVERNO.md`.

## Login

```bash
# UI: http://argocd.localhost/  - user admin, password:
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
```

(`argocd-initial-admin-secret` exists on this cluster ✅; ArgoCD's docs recommend deleting it after
you change the password.)

## Optional: the `argocd` CLI

Not installed here, and none of the commands below were run. `argocd-server` is patched with
`--insecure` and reached through the plain-HTTP `*.localhost` Ingress, hence the flags:

```bash
argocd login argocd.localhost --plaintext --grpc-web --username admin

argocd app list
argocd app get graphql-apollo-prisma-o2
argocd app diff graphql-apollo-prisma-o2          # live vs git
argocd app sync graphql-apollo-prisma-o2
argocd app history graphql-apollo-prisma-o2
argocd app set graphql-apollo-prisma-o2 --sync-policy none      # pause auto-sync
```
