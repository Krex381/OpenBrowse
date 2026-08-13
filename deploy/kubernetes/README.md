# Kubernetes deployment

The bundled manifest runs one replica because its default SQLite store is a
single-writer database. Use a shared production store before increasing the
replica count.

## Prerequisites

Install `deploy/seccomp_profile.json` on every node as the Localhost profile
`openbrowse-playwright.json`. For containerd, a common location is:

```text
/var/lib/kubelet/seccomp/profiles/openbrowse-playwright.json
```

Create the secret outside source control:

```sh
kubectl create secret generic openbrowse-secrets \
  --from-literal=api-keys='replace-with-a-long-random-api-key' \
  --from-literal=encryption-key='replace-with-a-stable-secret-of-at-least-32-characters'
```

Provision a `ReadWriteOnce` PVC named `openbrowse-data`, then apply
`openbrowse.yaml`.

## Egress policy

The manifest permits browser and target HTTP egress only through a proxy in
the same namespace labelled `app: openbrowse-egress-proxy` on TCP 3128. The
proxy must reject loopback, private, link-local, Kubernetes service/node, and
cloud metadata ranges after DNS resolution. Do not replace that rule with a
wide `0.0.0.0/0` egress policy.

Keep raw browser bridges and full Lighthouse disabled unless their traffic is
handled by a separate, egress-isolated worker.
