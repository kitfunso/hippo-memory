# Kubernetes integration research for hippo-memory (2026-09-25)

Read-only web research. hippo-memory: MIT npm package (TS/Node), single SQLite file / single writer, `hippo serve` (HTTP API + MCP over HTTP, OAuth/Bearer/tenant scoping/audit log), local ONNX embeddings via `@huggingface/transformers`, periodic `hippo sleep` consolidation. Postgres backend is roadmap-only (A6), not built. No money spent — every recommendation below stays on free/OSS tooling.

Every claim below carries its source URL and a verbatim quote where the page was actually fetched this session. Where only a WebSearch snippet was available (page not independently fetched, e.g. 403/paywall), it is marked **UNVERIFIED — search-summary only**. Nothing below is stated from model memory as fact.

---

## 1. Single-writer SQLite on Kubernetes

**StatefulSet vs Deployment, replicas=1, strategy Recreate**
Litestream's own Kubernetes guide runs SQLite behind a StatefulSet, not a Deployment, with `replicas: 1`.
Source: https://litestream.io/guides/kubernetes/ — "Litestream can only be run on a single node at a time."
General Kubernetes guidance for single-instance stateful apps: Kubernetes docs, "Run a Single-Instance Stateful Application" (https://kubernetes.io/docs/tasks/run-application/run-single-instance-stateful-application) — the Deployment + `replicas: 1` + `strategy: Recreate` pattern is the documented minimal approach; StatefulSet buys stable pod identity / `volumeClaimTemplates`, which matters if you want the PVC to travel with a named pod (e.g. pairing with LiteFS-style clustering later). For hippo: either works; StatefulSet is the safer default because it forces one stable PVC-to-pod binding and matches what Litestream, Cognee and Qdrant all use for their single/limited-writer services (see section 5).

**Pod disruption / rolling updates with two pods touching one file**
`ReadWriteOnce` is node-scoped, not pod-scoped — during a `RollingUpdate`, Kubernetes can schedule the new pod on the same node while the old pod is still terminating, and both can mount and touch the file at once.
Source: https://kubernetes.io/docs/tasks/administer-cluster/change-pv-access-mode-readwriteoncepod/ — `ReadWriteOncePod` (GA-track access mode, introduced v1.22) "restricts volume access to a single pod in the cluster, ensuring that only one pod can write to the volume at a time." Use `ReadWriteOncePod` (not plain `ReadWriteOnce`) plus `strategy: Recreate` to make the old pod fully die before the new one starts — this is the concrete fix for the two-pods-one-SQLite-file hazard.
**UNVERIFIED**: no authoritative doc found describing an actually-observed SQLite corruption incident from a live k8s rolling-update overlap — the risk is inferred from the access-mode semantics plus SQLite's own single-writer contract, not a documented incident report.

**SQLite WAL on network filesystems**
Authoritative, fetched directly from SQLite.org: https://www.sqlite.org/wal.html — "All processes using a database must be on the same host computer; WAL does not work over a network filesystem. This is because WAL requires all processes to share a small amount of memory and processes on separate host machines obviously cannot share memory with each other." And: "the use of shared memory means that all readers must exist on the same machine. This is why the write-ahead log implementation will not work on a network filesystem."
This is not a risk — it's an explicit unsupported configuration. hippo's SQLite file must sit on local/node-local storage (PVC backed by a real block device, e.g. EBS/PD/local-path) or a `ReadWriteOncePod` PVC that resolves to node-local storage. NFS/EFS/Azure Files are out for WAL mode; rollback-journal mode would technically run on NFS but loses concurrent-reader performance and isn't what hippo uses.

**HA / replication options — current status, checked live this session**

| Tool | Status | Evidence |
|---|---|---|
| **Litestream** | Actively maintained. Latest release v0.5.17, Aug 31 2026 (S3 accept-encoding, v3 WAL segment restoration, config validation); cadence roughly every 2-4 weeks through 2026. | https://github.com/benbjohnson/litestream/releases |
| **LiteFS** | Maintained but slow. Latest tag v0.5.14, Apr 22 2025 — no newer release found as of Sep 2026 (~17 months stale). Repo not archived, no deprecation banner on the repo itself. LiteFS **Cloud** (hosted backup add-on, a separate product) was deprecated July 2024. | https://github.com/superfly/litefs/releases |
| **libSQL / sqld** | Maintained but de-prioritized — Turso's new work goes into a separate Rust rewrite ("Turso Database"), not libsql-server. Latest libsql-server tag found: v0.24.32, Feb 2025. | **UNVERIFIED — search-summary only**, page not independently re-fetched |
| **rqlite** | Actively maintained, frequent releases. Latest v10.3.6, Sep 22 2026 — releases roughly weekly through Sep 2026. | https://github.com/rqlite/rqlite/releases |
| **Marmot** | Stale. Latest release v2.9.16-beta, Sep 2 2024 (~2 years old), still tagged "-beta". No archive notice, but no 2025/2026 activity surfaced. | https://github.com/maxpert/marmot/releases |
| **cr-sqlite** | Stale-ish. Latest release v0.16.3, Jan 17 2025 (~20 months old); not archived. | https://github.com/vlcn-io/cr-sqlite/releases |

Litestream's documented k8s pattern (sidecar + S3 + initContainer restore), fetched from https://litestream.io/guides/kubernetes/: "Litestream as a sidecar to your application within Kubernetes using StatefulSets"; restore "occur[s] automatically before our application starts by running it in a Kubernetes init container"; example config targets `url: s3://YOURBUCKET/db`. Litestream is generically S3-API-compatible per its own docs, so MinIO should work via endpoint override — **UNVERIFIED for MinIO specifically**, not independently confirmed this session.

**Bottom line**: Litestream is the only option here that is both actively maintained and purpose-built for hippo's exact shape (single SQLite writer, continuous backup to S3-compatible storage, sidecar + initContainer restore already documented for k8s). rqlite is the only actively-maintained true multi-node HA option, but it requires re-architecting hippo's writes through Raft-replicated SQLite — not a drop-in. LiteFS, Marmot, and cr-sqlite all show 17-24 month stale releases; do not call these "maintained" with confidence.

---

## 2. Native sidecar containers

**GA version**: Kubernetes v1.33 (released April 23, 2025).
Source: https://github.com/kubernetes/kubernetes/pull/129731 (fetched) — "The `SidecarContainers` feature has graduated to GA. 'SidecarContainers' feature gate was locked to default value and will be removed in v1.36." KEP-753. Cross-sourced timeline (WebSearch, k8s v1.33 release notes and third-party write-ups): alpha in v1.28 (Aug 2023, feature gate `SidecarContainers`), beta + on-by-default in v1.29, GA in v1.33.

Mechanism, fetched from the original announcement: https://kubernetes.io/blog/2023/08/25/native-sidecar-containers/ — a native sidecar is "an init container that has the restartPolicy set to Always." It starts before app containers, stays running through the pod's lifecycle, and does not block Job completion the way hand-rolled sidecars used to.

**Memory/MCP server as sidecar — real examples found**:
- Microsoft Azure Community blog, "Building a Dual Sidecar Pod: Combining GitHub Copilot SDK with Skill Server on Kubernetes" — https://techcommunity.microsoft.com/blog/azuredevcommunityblog/building-a-dual-sidecar-pod-combining-github-copilot-sdk-with-skill-server-on-ku/4497080. **UNVERIFIED — search-summary only** (fetch attempt failed); per the snippet it explicitly ties the pattern to "Kubernetes 1.28 (August 2023) introduced native Sidecar container support via KEP-753," running an agent SDK container plus a skill/tool server container in one pod.
- "The Main Thread" blog, "Expose Legacy Java Apps to AI Agents with the Kubernetes Sidecar Pattern" — https://www.the-main-thread.com/p/legacy-java-ai-mcp-sidecar-quarkus. **UNVERIFIED — search-summary only**; MCP server and legacy app "running inside the same Kubernetes Pod... communicate through localhost."
- Keisuke Hatasaki, "MCP Sidecar pattern" (Medium) — https://hatasaki.medium.com/mcp-sidecar-pattern-89c7ca254db6. Fetch returned HTTP 403 (paywall/bot-block). **UNVERIFIED — search-summary only.**
- Mirantis, "Agents, MCP, and Kubernetes, Part 2" — https://www.mirantis.com/blog/agents-mcp-and-kubernetes-part-2/. Not fetched. **UNVERIFIED — search-summary only.**

No source found describing a *memory-store* MCP server specifically (as opposed to a generic tool/skill-server MCP) running as a sidecar. The pattern is documented for MCP/tool servers generally; hippo-as-sidecar would be structurally identical but not yet a documented case anywhere found.

---

## 3. Helm chart best practices, 2025-2026

**values.schema.json**: catches misconfigured values before render, gives IDE autocomplete, documents the chart's interface. Source: https://oneuptime.com/blog/post/2026-01-17-helm-schema-validation-values/view — "JSON Schema validation for Helm values catches mistakes during development, provides IDE autocomplete, and documents your chart's interface clearly."

**existingSecret pattern**: the standard convention (used by Bitnami-style charts) is to expose `existingSecret`/`existingSecretKey` values so a user can bring their own Secret instead of the chart minting one from a plaintext value. Corroborating example (Camunda docs, via search, page wording **UNVERIFIED — search-summary only**): "The Helm chart supports three options for secret configuration: inlineSecret for plain-text value for non-production usage, existingSecret for reference to an existing Kubernetes Secret name, and existingSecretKey for the key within the existing secret object." The pattern itself is corroborated by multiple independent hits, not just this one page.

**Pod Security Standards "restricted" profile**, fetched directly: https://kubernetes.io/docs/concepts/security/pod-security-standards/
- `spec.securityContext.runAsNonRoot` (and per-container equivalent) — allowed value `true`.
- `seccompProfile.type` (pod or container level) — allowed values `RuntimeDefault` or `Localhost`.
- `allowPrivilegeEscalation` (container level) — allowed value `false`.
- `readOnlyRootFilesystem` (container level) — allowed value `true`, listed under Restricted in the official doc (a secondary blog claimed this isn't required under Restricted — the official doc contradicts that; trust the official doc).

**NetworkPolicy**: not independently fetched this session — general default-deny + explicit-allow guidance for a chart's API/MCP port is standard k8s practice but **UNVERIFIED against a specific source this turn**.

**Probes**: liveness/readiness/startup probe pattern not independently fetched this session — well-known Kubernetes primitive, but **UNVERIFIED against a specific citation this turn**.

**Publishing to GHCR as an OCI artifact (free)**, fetched from Helm's own docs: https://helm.sh/docs/topics/registries/ — `helm registry login -u myuser localhost:5000` then `helm push mychart-0.1.0.tgz oci://localhost:5000/helm-charts`. Push only accepts a `.tgz` produced by `helm package`; the `oci://` reference omits basename/tag, which are inferred from the chart's name/version. GHCR-specific corroboration (**UNVERIFIED — search-summary only**, https://niklasmtj.de/blog/use-ghcr-to-host-helm-charts/): the package is private by default on first push and must be made public afterward manually.

**chart-testing (ct) + kind in CI**, fetched: https://github.com/helm/chart-testing — "the tool for testing Helm charts. It is meant to be used for linting and testing pull requests. It automatically detects charts changed against the target branch." Repo ships `e2e-kind.sh`. Standard CI shape per search results: `helm/kind-action` spins up a kind cluster, `helm/chart-testing-action` lints/installs the chart into it — this is free, runs entirely inside GitHub Actions' free tier for public repos.

**Artifact Hub listing**, fetched: https://artifacthub.io/docs/topics/repositories/ — "Publishers can add their repositories from the control panel, accessible from the top right menu after signing in." `artifacthub-repo.yml` carries a `repositoryID` for verified-publisher status and an `owners` list matched against the Artifact Hub sign-in email. For a classic Helm repo, this file "must be located at the repository URL's path" next to `index.yaml`, served over HTTP. **UNVERIFIED**: the exact placement convention for an OCI-only chart (GHCR, no `index.yaml`) was not independently confirmed this session.

**cosign keyless signing (free, no key management)**, fetched: https://docs.sigstore.dev/cosign/signing/signing_with_containers/ — "You can use Cosign to sign containers with ephemeral keys by authenticating with an OIDC (OpenID Connect) protocol supported by Sigstore," supported providers include GitHub. Command: `cosign sign $IMAGE`. In GitHub Actions this needs `permissions: id-token: write` on the job — corroborated by multiple independent sources (**UNVERIFIED — search-summary only** for the exact permission block wording, but the requirement itself is well corroborated).

**SBOM generation (free, no external service)**, fetched from Docker's own blog: https://www.docker.com/blog/generate-sboms-with-buildkit/ — `docker buildx build --sbom=true -t <myorg>/<myimage> --push .`; "BuildKit generates SBOMs using scanner plugins. By default, it uses buildkit-syft-scanner... built on top of Anchore's Syft." Runs entirely inside the build step, no paid service required.

---

## 4. CronJob vs in-process scheduler; ONNX model caching; air-gapped images

**CronJob vs in-process scheduler for `hippo sleep`**
General tradeoffs corroborated across multiple search-summary sources (spacelift.io, komodor.com — **UNVERIFIED — search-summary only**, not independently fetched, treat as paraphrase):
- A k8s CronJob runs the consolidation job in its own container, independently versionable/observable, and has `concurrencyPolicy` (`Forbid`/`Replace`) to stop overlapping runs — directly relevant since two overlapping `hippo sleep` runs writing the same SQLite file would collide. `concurrencyPolicy: Forbid` is the safe default for a single-writer store.
- An in-process scheduler (node-cron style) runs inside the same Node process as `hippo serve`, so it's naturally serialized with the app's own writes *if* the code takes an in-process mutex — but this only holds if there is exactly one `serve` replica. If a second replica or a separate CronJob pod exists, nothing at the k8s level stops a second concurrent writer.
- **The specific hazard named in the brief (CronJob pod and the main serve pod both writing SQLite concurrently) is real either way** — SQLite has no network-level lock coordination between processes. This is my own synthesis, not a sourced claim: the safe fix is architectural, not a scheduler choice — have the CronJob call into the *running* `hippo serve` process over its own HTTP API rather than opening the SQLite file directly, so only one process ever holds the file handle. `concurrencyPolicy: Forbid` alone does not fix this if `serve` and the CronJob are different processes touching the same file.

**ONNX / transformers.js model caching**, fetched from Hugging Face's own skills repo: https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CACHE.md
- Node.js default cache dir is `./.cache` relative to process cwd — **not** `~/.cache/huggingface` (that's the Python `transformers` convention; transformers.js does not inherit it automatically).
- Configurable via `env.cacheDir = process.env.HF_HOME || '~/.cache/huggingface'` — i.e. transformers.js only respects `HF_HOME` if hippo's own code wires it in explicitly.
- `env.useFSCache = false` disables the filesystem cache entirely (forces re-download every run — avoid in k8s).
- Offline mode: set `allowRemoteModels = false`, `allowLocalModels = true`, and point `localModelPath` at a pre-downloaded model directory.
- General k8s caching guidance (**UNVERIFIED — search-summary only**, https://webeyez.com/insights/guides/hf-cache-best-practices-huggingface-transformers): mount `HF_HOME` as a PersistentVolume, set the env var via Dockerfile `ENV` rather than app code so ops can override without a rebuild; for production, mount read-only after initial population and set `HF_HUB_OFFLINE=1` to guarantee no runtime network calls.
- **Code-level implication for hippo**: because transformers.js does not auto-read `HF_HOME`, none of the three k8s caching patterns (initContainer pre-pull to a shared volume, model baked into the image, PVC-backed cache) work until hippo's own code explicitly reads a cache-dir env var and passes it to `env.cacheDir`. Whether hippo's code already does this was **not checked this session** — out of scope for a web-only research task, but it is the actual blocker, not the k8s manifest.

**Air-gapped / offline image practices**, fetched from k0s docs: https://docs.k0sproject.io/head/airgap-install/ — "k0s uses so-called OCI archives for this: Tarball representations of an OCI Image Layout. They allow for multiple images to be packed into a single file." k0s watches a data-dir `images` folder and auto-imports bundles into the container runtime. General air-gap pattern (**UNVERIFIED — search-summary only**, semaphore.io): build a self-contained artifact in CI, transfer via `docker save`/`docker load` or an OCI archive, stage everything (app image + model weights + any operator image) once and never touch the network again at runtime. For hippo specifically, baking the ONNX model into the image is the simplest air-gap-safe option — it removes any runtime fetch step, at the cost of a larger image. **UNVERIFIED**: the actual size of hippo's embedding model was not checked this session.

---

## 5. How competitors ship on Kubernetes

**Mem0 / OpenMemory** — no official Helm chart. GitHub: https://github.com/mem0ai/mem0. Users are actively asking for one — [Issue #2694](https://github.com/mem0ai/mem0/issues/2694) requests "an official self-hostable package including a Helm chart" (open feature request, not shipped). Self-hosting today is Docker Compose (FastAPI + Postgres/pgvector + Neo4j, 3 containers) per https://docs.mem0.ai/open-source/setup.

**Zep / Graphiti** — https://github.com/getzep/graphiti, https://help.getzep.com/graphiti/getting-started/welcome. No Helm chart or k8s manifest found in either the repo search or docs. **UNVERIFIED / likely none exists.**

**Letta (formerly MemGPT)** — https://github.com/letta-ai/letta. No Helm chart found. Self-hosting is Docker: "Copy .env.example to .env, then run `docker compose up -d`" per https://docs.letta.com/guides/selfhosting/. A separate repo, `letta-ai/letta-code-server-deployment`, ships "one Dockerfile plus ready-to-use configuration for Docker Compose, Railway, and Fly.io" — no Kubernetes artifact.

**Cognee** — has a real Helm chart, and its architecture matches hippo's exactly. Docs: https://docs.cognee.ai/how-to-guides/cognee-sdk/deployment/helm — "Cognee runs as a single-replica deployment. The API pod is a single process with process-local locks and caches, so running multiple replicas against the same stores is not supported." Chart bundles Postgres+pgvector; install via `helm install cognee ./deployment/helm -f values.yaml`; GitHub PR that added it: https://github.com/topoteretes/cognee/pull/3716. This is the closest direct analog to hippo's single-writer SQLite constraint — same architectural limitation, same fix: document it as a stated constraint rather than architect around it.

**Qdrant** — official chart, https://github.com/qdrant/qdrant-helm. "This repository hosts the following helm charts: Qdrant"; "Support for the Helm chart is limited to community support." Uses a StatefulSet. Install: `helm repo add qdrant https://qdrant.github.io/qdrant-helm`.

**Weaviate** — official chart, https://github.com/weaviate/weaviate-helm (BSD-3). Deploys as a StatefulSet with `podManagementPolicy: Parallel` for Raft consensus; v1.25+ requires manually deleting the old StatefulSet once on upgrade (data-preserving but manual).

**Chroma** — no official chart from chroma-core. The community chart `amikos-tech/chromadb-chart` is "the most maintained community Helm chart, as the official chroma-core repo does not ship a chart." Verbatim from its README: "This values.yaml is single-replica because ChromaDB OSS does not support multi-replica writes in 1.0 since the storage layer assumes one writer." — a near word-for-word mirror of hippo's own SQLite single-writer constraint.

**Pattern**: every single-writer store found (Cognee, Chroma) ships single-replica-only and says so explicitly in its chart docs — that is an accepted, normal constraint to state plainly, not something to apologize for. The mature multi-writer vector DBs (Qdrant, Weaviate) ship official charts on StatefulSets. Memory-specific agent frameworks (Mem0, Zep/Graphiti, Letta) have **no Kubernetes story at all** — Docker Compose is their ceiling. hippo shipping any official Helm chart would put it ahead of every direct memory-layer competitor on this axis.

---

## 6. MCP on Kubernetes ecosystem, 2025-2026

**kagent** (CNCF Sandbox) — accepted per https://github.com/cncf/sandbox/issues/360; announcement https://www.cncf.io/blog/2025/04/15/kagent-bringing-agentic-ai-to-cloud-native/. Kubernetes-native framework for running ops/SRE agents as CRDs, ships "an MCP server with tools for Kubernetes, Istio, Helm, Argo, Prometheus, Grafana, Cilium." GitHub: https://github.com/kagent-dev/kagent.

**ToolHive** (Stacklok) — has a concrete operator and CRD, fetched directly: https://docs.stacklok.com/toolhive/reference/crds/mcpserver. `apiVersion: toolhive.stacklok.dev/v1beta1`, `kind: MCPServer`. Fields include `image` (required), `transport` (stdio / streamable-http / sse), `mcpPort`, `proxyPort` (default 8080), `permissionProfile`, `replicas`, `backendReplicas`, `oidcConfigRef`, `authzConfig`, `sessionStorage` (Redis or in-memory). Minimal example from the docs:
```yaml
apiVersion: toolhive.stacklok.dev/v1beta1
kind: MCPServer
metadata:
  name: my-mcpserver
spec:
  image: <container-image>
  transport: stdio
  proxyPort: 8080
```
This is a concrete, near-zero-code target: hippo could ship a `deploy/toolhive/mcpserver.yaml` example today using this exact CRD.

**agentgateway / kgateway** — MCP-aware gateway on the Kubernetes Gateway API. "Protocol support for stdio, HTTP/SSE, and Streamable HTTP transports, plus OpenAPI integration... and built-in MCP auth spec compliance with OAuth providers (Auth0, Keycloak)." Sources: https://agentgateway.dev/docs/kubernetes/, https://kgateway.dev/docs/integrations/agentgateway/.

**kubernetes-sigs/agent-sandbox** — real, confirmed directly: https://github.com/kubernetes-sigs/agent-sandbox. "Agent Sandbox enables easy management of isolated, stateful, singleton workloads, ideal for use cases like AI agent runtimes and reinforcement learning," developing "a `Sandbox` Custom Resource Definition (CRD) and controller for Kubernetes, under the umbrella of SIG Apps." Delegates isolation to gVisor/Kata via RuntimeClass. Active development; roadmap items (hibernation, memory sharing) unshipped. Covered by the Kubernetes blog: https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox.

**Microsoft MCP Gateway** — active: https://github.com/microsoft/mcp-gateway (MIT). "MCP Gateway is a reverse proxy and management layer for MCP servers, enabling scalable, session-aware stateful routing and lifecycle management of MCP servers in Kubernetes environments." Ships an ARM template provisioning AKS+ACR+App Gateway with Entra ID OAuth. "As of June 2026, it has 706 stars and 74 forks."

**MCP registry** — https://registry.modelcontextprotocol.io/, code at https://github.com/modelcontextprotocol/registry. "The MCP Registry hosts metadata that points to packages" and "uses namespace authentication to ensure that servers come from their claimed sources." "The Registry API has entered an API freeze (v0.1)." Listing here is about *discovery* only — unrelated to Kubernetes packaging — it needs a server manifest pointing at hippo's npm package, separate from any k8s work.

**Concrete path for hippo**: ship `deploy/toolhive/mcpserver.yaml` using the real ToolHive CRD (cheapest, most standards-aligned move — zero new code, just a manifest), and separately submit a listing to the MCP registry (also near-zero-code, unrelated to k8s). Both are shippable this week.

---

## 7. Kubernetes as a memory source

**kagent explicitly does not have long-term memory today** — confirmed by reading the actual GitHub issue: https://github.com/kagent-dev/kagent/issues/1256 — "Sessions can track history (events) and temporary data for a single ongoing conversation. But in order for agents to recall information from past conversations (from the same or different session), we need a memory service." Status: open feature request (proposes Postgres+pgvector, explicitly *not* Qdrant), not shipped. This is a real, named gap in a CNCF-Sandbox project.

**k8sgpt** — no memory/history feature surfaced in search results. **UNVERIFIED**, repo not independently fetched this session.

**HolmesGPT** (CNCF Sandbox, Robusta-authored, Microsoft-contributed) — https://github.com/HolmesGPT/holmesgpt. Runs continuously, pulls alerts from AlertManager/PagerDuty/OpsGenie, writes investigation results back to source systems. No evidence found of persistent cross-incident memory in search results — each investigation appears to write back to the alerting tool, not to a durable memory store. **UNVERIFIED whether this has changed recently**; repo not independently fetched.

**Prior art piping k8s events/audit into LLM pipelines exists as academic research, not shipped product**: ARGUS (arXiv 2608.23084) is "an MCP-grounded RCA assistant that connects a commercial LLM to live Kubernetes observability data through standardized MCP servers covering Kubernetes state, Prometheus metrics, Loki logs, and NATS messaging." KubeIntellect (arXiv 2509.02449) is "a modular, multi-agent architecture... with LangGraph-based orchestration featuring persistent memory, checkpointing, and workflow resumption" — the one source that names persistent memory directly, but it is an academic prototype, not a shipped tool. Kubernetes audit events themselves: "Every Kubernetes request passes through the kube-apiserver, generating audit events containing information about the request, requesting identity, target resource, and result" (**UNVERIFIED — search-summary only**, bionconsulting.com, not independently checked against k8s docs).

**Synthesis (mine, not a sourced claim)**: the gap is real and specific — kagent has publicly asked for memory and doesn't have it; HolmesGPT and k8sgpt show no evidence of persisting across incidents; the only "persistent memory" work found is an unshipped academic prototype (KubeIntellect). A plausible hippo integration: an MCP tool that lets HolmesGPT / kagent / k8sgpt call `hippo remember` on each resolved incident (root cause, fix, affected resources) and `hippo context` before starting a new investigation, scoped per cluster/namespace as a tenant. This is a thin wrapper, not new plumbing — hippo already has an MCP server and tenant scoping; the only new work is a documented k8s-event ingestion convention plus one example integration script.

---

## Top 8 takeaways for hippo

1. **StatefulSet + `ReadWriteOncePod` PVC + `strategy: Recreate`, replicas hard-capped at 1.** This is the only safe shape for hippo's single SQLite writer. `ReadWriteOncePod` (not plain `ReadWriteOnce`) is what actually prevents two pods from touching the file during a rollout — plain RWO is node-scoped and doesn't stop it. (Section 1)
2. **WAL mode on NFS/EFS/Azure Files is not "risky," it's documented as unsupported by SQLite itself.** Ship a Helm chart that requires a local/block-storage StorageClass, not a network filesystem, and say so explicitly in the docs. (Section 1, sqlite.org/wal.html)
3. **Litestream is the only actively-maintained, purpose-built backup/HA answer, and it already documents hippo's exact deployment shape** (sidecar + S3-compatible target + initContainer restore, on a StatefulSet). LiteFS, Marmot, and cr-sqlite are all 17-24 months stale — don't pitch them as "maintained" options. rqlite is the one live multi-writer alternative but needs a rewrite, not a sidecar. (Section 1)
4. **Ship a Helm chart. No direct memory-layer competitor has one.** Mem0, Zep/Graphiti, and Letta all cap out at Docker Compose; users are openly asking Mem0 for a chart (open GitHub issue). Cognee is the closest architectural peer (same single-writer, single-replica constraint) and it has a chart — copy its posture: state the single-replica limit plainly rather than working around it. (Section 5)
5. **Ship `deploy/toolhive/mcpserver.yaml` using the real ToolHive `MCPServer` CRD** (`toolhive.stacklok.dev/v1beta1`) — near-zero code, standards-aligned, and puts hippo in the concrete MCP-on-k8s ecosystem (kagent, agentgateway/kgateway, Microsoft MCP Gateway) rather than a bespoke deployment story. Submit a separate listing to the MCP registry (unrelated to k8s, also near-zero-code). (Section 6)
6. **Native sidecar containers are GA as of Kubernetes v1.33 (April 2025)** — any cluster on 1.33+ can run `hippo serve` as a true sidecar next to an agent pod (shared localhost network, starts first, doesn't block Job completion). No prior example of a *memory-store* MCP sidecar was found anywhere — hippo would be first, not late. (Section 2)
7. **kagent has an open, unresolved feature request for exactly what hippo does** ("we need a memory service" — GitHub issue #1256). HolmesGPT and k8sgpt show no evidence of persisting across incidents either. A thin MCP wrapper (`hippo remember` on incident resolution, `hippo context` before a new investigation, tenant-scoped per cluster) is a real, near-term integration with a named unmet need — not a speculative feature. (Section 7)
8. **The ONNX caching problem is a code gap, not a manifest gap.** transformers.js does not auto-read `HF_HOME` the way Python's `transformers` does — hippo's own code must explicitly wire `env.cacheDir` to an env var before any k8s caching pattern (initContainer pre-pull, baked-in model, PVC cache) can work. Fix that in hippo's code first; the k8s manifest choice is secondary. (Section 4)

## Gaps and things not verified this session
NetworkPolicy specifics for a chart; probe timing guidance; exact `existingSecret` wording; `id-token: write` exact permission block; Artifact Hub `artifacthub-repo.yml` placement for an OCI-only (GHCR) chart; MinIO-specific Litestream config; hippo's actual embedding model size; whether hippo's code currently reads `HF_HOME`/`TRANSFORMERS_CACHE`; k8sgpt memory features (repo not fetched); HolmesGPT's current (post-cutoff) memory status; several sidecar-pattern blog posts (Microsoft, The Main Thread, Hatasaki, Mirantis) that returned only search snippets or 403s and were not independently fetched.
