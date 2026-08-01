# AWS Cloud Migration Plan

## Current State — Local Docker Demo

| Component | Technology | Details |
|---|---|---|
| Database | PostgreSQL 18 + pgvector (Docker) | 12+ tables (user sources, logs, `agent_tickets`, `chat_messages`, `m365_group_memberships`), HNSW indexes, bind-mounted data dir |
| ETL | 6 Docker line containers (node:22) | AD, NetForum, External Users, Distribution Groups, M365, SharePoint. Cron-scheduled (hourly), SBERT `Xenova/all-MiniLM-L6-v2`, shared model cache volume |
| App | Docker container (node:22, Express) | Port 3000, SBERT at query time, cosine similarity search, proxies agent/ticket requests to GenAI service |
| GenAI | Docker container (node:22, Express) + Ollama sidecar | Port 3001, LLM tool-calling agent (`qwen2.5:3b` — **local dev only**), 9 tools, 6 action executors, cross-system provisioning, M365 group management |
| Orchestration | Docker Compose (9 YAML fragments) | `npm run dev:up` brings up full stack |
| CI | TeamCity → Artifactory push | Matrix build for images, triggered on merge |

## Target State — AWS Production

| Component | AWS Service | Details |
|---|---|---|
| Database | **Amazon RDS** (PostgreSQL 18 + pgvector) | Multi-AZ, encrypted at rest, Secrets Manager for credentials |
| ETL | **AWS Lambda** (6 functions) | EventBridge scheduled, reads from S3, writes to RDS |
| App | **Amazon EKS** (EC2 node group) | ALB Ingress Controller, HPA auto-scaling, Artifactory image |
| GenAI agent | **Amazon Bedrock** | See Phase 5 below; replaces Ollama with managed Bedrock LLM API |
| Model cache | **Amazon EFS** or **S3 + Lambda layer** | Shared SBERT model weights (~80 MB) |
| Data source | **Amazon S3** | `primary.json` and `logs.json` per data line |
| Scheduling | **Amazon EventBridge** | Replaces `node-cron`; triggers Lambda on schedule |
| Secrets | **AWS Secrets Manager** | Already referenced in CI; extends to runtime |
| DNS / TLS | **Route 53 + ACM** | HTTPS termination at ALB |

---

## Architecture Diagram

See [docs/diagrams/aws-target-architecture.md](diagrams/aws-target-architecture.md) for the full Mermaid diagram.

---

## Migration Phases

### Phase 1 — Database (RDS)

**Goal:** Move Postgres off Docker onto a managed RDS instance.

| Step | Action |
|---|---|
| 1.1 | Create RDS PostgreSQL 18 instance with `pgvector` extension enabled |
| 1.2 | Run `infra/db/init/01_create_schema.sql` through `15_agent_tickets.sql` against RDS |
| 1.3 | Store RDS credentials in Secrets Manager (already set up for CI) |
| 1.4 | Update app and GenAI service `DATABASE_URL` to point to RDS endpoint |
| 1.5 | Update ETL `PGHOST`/`PGPASSWORD` env vars to use Secrets Manager |
| 1.6 | Remove `docker-compose.postgres.yml` from `dev:up` (or keep for local dev) |

**RDS Configuration:**
```
Engine:            PostgreSQL 18
Instance class:    db.t3.medium (start), scale as needed
Storage:           gp3, 20 GB (HNSW indexes are ~60 MB for 14k records)
Multi-AZ:          Yes (production)
Encryption:        KMS default key
VPC:               Private subnets only
Security group:    Allow 5432 from Lambda SG + EKS node group SG (app + genai)
Parameter group:   shared_preload_libraries = 'vector'
```

**pgvector on RDS:** pgvector is available as an extension on RDS PostgreSQL 18. Enable with:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

### Phase 2 — ETL (Lambda)

**Goal:** Replace 6 Docker line containers with 6 Lambda functions.

#### Key Architecture Changes

| Concern | Docker (current) | Lambda (target) |
|---|---|---|
| Runtime | Long-running container + `node-cron` | Event-driven invocation (EventBridge) |
| Model loading | Once at container startup, reused across cron ticks | Cold start: load from EFS/S3; warm start: reused in-memory |
| Data source | `data/primary.json` mounted into container | S3 bucket (`s3://user-search-data/etl-ad-line/primary.json`) |
| Connection pool | Persistent `pg.Pool` | RDS Proxy (connection pooling) to avoid Lambda connection storms |
| Memory | ~512 MB per container (model + pool) | Lambda: 1024–2048 MB (SBERT model needs ~400 MB) |
| Timeout | Unlimited (container) | Up to 15 min (sufficient for 6,000 records at 64/batch) |
| Scheduling | `node-cron` in process | EventBridge rule: `rate(1 hour)` or `cron(0 * * * ? *)` |

#### Lambda Function Structure

Each of the 6 Lambda functions follows this pattern:

```
etl-ad-line-lambda/
├── handler.js          # Lambda entry point (exports.handler)
├── vectorize.js        # Existing pipeline logic (runPrimary, runLogs)
├── package.json
└── model/              # SBERT model weights (via Lambda layer or EFS mount)
```

**handler.js** (new file per function):
```js
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { RDSDataClient } = require('@aws-sdk/client-rds-data');

exports.handler = async (event) => {
  // 1. Load model (warm starts reuse global)
  // 2. Read primary.json + logs.json from S3
  // 3. Run vectorize pipeline against RDS (via RDS Proxy)
  // 4. Return summary
};
```

#### SBERT Model in Lambda

The `Xenova/all-MiniLM-L6-v2` model is ~80 MB. Options:

| Option | Pros | Cons |
|---|---|---|
| **Lambda Layer** | Fast cold start, versioned | 250 MB unzipped limit (fine for this model) |
| **EFS mount** | Shared across functions, no size limit | Requires VPC, slight latency on first access |
| **S3 download at cold start** | Simple, no VPC needed | Adds 2–5s to cold start |

**Recommendation:** Lambda Layer for the model weights. Package the ONNX model files into a layer, reference in all 4 functions.

#### RDS Proxy

Lambda functions can exhaust RDS connection limits. Use **RDS Proxy**:
- Sits between Lambda and RDS
- Pools and reuses connections
- IAM authentication (no passwords in Lambda env)

```
Lambda → RDS Proxy (port 5432) → RDS PostgreSQL
```

#### EventBridge Schedule

Replace `node-cron` with 6 EventBridge rules (one per ETL line — AD, NetForum, EU, DG, M365, SP):

```yaml
# Example (CloudFormation / SAM)
EtlAdLineSchedule:
  Type: AWS::Events::Rule
  Properties:
    ScheduleExpression: "rate(1 hour)"
    Targets:
      - Arn: !GetAtt EtlAdLineFunction.Arn
        Id: etl-ad-line-hourly
```

#### Vectorize.js Refactoring Required

| Current code | Change needed |
|---|---|
| `fs.readFileSync('data/primary.json')` | Read from S3 (`GetObjectCommand`) |
| `new Pool({ host: 'postgres' })` | Use RDS Proxy endpoint + IAM auth or Secrets Manager |
| `cron.schedule(...)` | Remove — EventBridge handles scheduling |
| `main()` with model load + cron setup | Export `handler()` that loads model (or reuses warm global) |
| `process.exit(1)` on fatal | Throw error (Lambda retries or DLQ) |

---

### Phase 3 — App (EKS)

**Goal:** Run the Express app in a Kubernetes pod on Amazon EKS (EC2 node group) behind the AWS Load Balancer Controller.

#### Kubernetes Manifests

```yaml
# k8s/app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-search-app
  namespace: user-search
spec:
  replicas: 2
  selector:
    matchLabels:
      app: user-search-app
  template:
    metadata:
      labels:
        app: user-search-app
    spec:
      imagePullSecrets:
        - name: artifactory-pull-secret
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: app
          image: artifactory.example.com/user-search/app:latest
          ports:
            - containerPort: 3000
          env:
            - name: PORT
              value: "3000"
            - name: TOP_K
              value: "20"
            - name: GENAI_URL
              value: "http://user-search-genai:3001"
          envFrom:
            - secretRef:
                name: user-search-db-secret   # DATABASE_URL, API_KEY
          resources:
            requests:
              cpu: "250m"
              memory: "512Mi"
            limits:
              cpu: "500m"
              memory: "1Gi"
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: user-search-app
  namespace: user-search
spec:
  selector:
    app: user-search-app
  ports:
    - port: 3000
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: user-search-app
  namespace: user-search
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: <ACM_CERT_ARN>
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS": 443}]'
spec:
  rules:
    - host: user-search.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: user-search-app
                port:
                  number: 3000
```

#### Key EKS Considerations

| Concern | Detail |
|---|---|
| Image registry | Images built in CI and pushed to Artifactory; pod spec references the Artifactory image URL with `imagePullSecrets` |
| SBERT model | Still loaded at container startup (~5s); pod stays warm — EKS does not terminate idle pods |
| Health check | Liveness/readiness probes on `GET /health`; add a `/health` endpoint to the app if not already present |
| Auto-scaling | Horizontal Pod Autoscaler (HPA) on CPU; `minReplicas: 1`, `maxReplicas: 4` |
| Networking | Pods in private subnets; ALB in public subnet via AWS Load Balancer Controller |
| DATABASE_URL | Injected via Kubernetes Secret — source from Secrets Manager using External Secrets Operator or AWS Secrets and Config Provider (ASCP) |
| GENAI_URL | Set to the GenAI Kubernetes Service DNS name (`http://user-search-genai:3001`) |
| Node group | `t3.medium` (2 vCPU, 4 GB) managed node group — sufficient to run app + genai pods on shared nodes |

#### ALB Ingress — AWS Load Balancer Controller

Install the AWS Load Balancer Controller in the EKS cluster; it provisions an ALB automatically from `Ingress` resource annotations:

```bash
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=user-search-eks \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=<IRSA_ROLE_ARN>
```

#### DNS + TLS

```
Internet → Route 53 (user-search.example.com)
         → ALB (HTTPS:443, ACM cert — provisioned by Ingress annotation)
         → EKS node group (private subnets)
         → App pod (port 3000)
```

#### Serverless Alternative — Lambda + serverless-http

If persistent pods are undesirable (e.g. bursty or unpredictable traffic), the Express app can be wrapped with `serverless-http` and deployed as a Lambda **zip package**. Note: Lambda container images require ECR, not Artifactory directly — the zip deployment path avoids this constraint entirely:

```js
// services/app/handler.js  (new file)
const serverless = require('serverless-http');
const app = require('./src/app');
exports.handler = serverless(app);
```

| Consideration | Detail |
|---|---|
| SBERT cold start | Model loads on cold start (~5–10s); set `MemorySize: 3008` to minimise load time |
| Warm reuse | Lambda reuses execution environments; cold starts occur only on first invocation or after idle period |
| Deployment | Zip package via SAM — no ECR required; Artifactory can store the built artefact |
| Cost | Very low for bursty/low traffic; EKS is more cost-effective at sustained load |
| Recommendation | Prefer EKS for predictable load where a warm SBERT process is important; Lambda viable for low-volume or dev/staging environments |

---

### Phase 4 — Data Pipeline (S3)

**Goal:** Move synthetic data to S3 and update the ETL Lambdas to read from it.

#### S3 Bucket Structure

```
s3://user-search-data/
├── etl-ad-line/
│   ├── primary.json
│   └── logs.json
├── etl-netforum-line/
│   ├── primary.json
│   └── logs.json
├── etl-eu-line/
│   ├── primary.json
│   └── logs.json
├── etl-dg-line/
│   ├── primary.json
│   └── logs.json
├── etl-m365-line/
│   ├── primary.json
│   └── logs.json
└── etl-sp-line/
    ├── primary.json
    └── logs.json
```

In production, these files would be generated by upstream systems (AD sync, netForum export, M365 Graph API, SharePoint API, etc.) and dropped into S3 — the Lambda functions trigger on schedule (or optionally on S3 `PutObject` events).

---

## CI/CD Pipeline Changes

### Current Pipeline
```
Merge → TeamCity → Image build → Push to Artifactory
```

### Target Pipeline
```
Merge → TeamCity → Build app image   → Push to Artifactory → kubectl rollout restart (EKS)
                 → Build genai image → Push to Artifactory → kubectl rollout restart (EKS)
                 → Package Lambda    → Deploy Lambda functions (CDK)
```

| Change | Detail |
|---|---|
| Trigger | TeamCity build configuration triggered on merge to main |
| App/GenAI deploy | Build image, push to Artifactory, then run `kubectl rollout restart deployment/user-search-app` (and genai) against the EKS cluster via service account-authenticated `kubectl` |
| Lambda deploy | Use AWS CDK (`cdk synth && cdk deploy`); upload to S3, update function code |
| No ECR required | Container images go to Artifactory; Lambda functions deploy as zip packages via CDK — neither path requires ECR |
| Add S3 sync step | Upload `data/*.json` files to S3 bucket if synthetic data changed |

### TeamCity Build Steps

The pipeline is defined as a TeamCity build configuration with the following steps:

```
Step 1 — Build & push container images (app + genai)
  docker build -t artifactory.example.com/user-search/app:%build.vcs.number% services/app
  docker push artifactory.example.com/user-search/app:%build.vcs.number%

  docker build -t artifactory.example.com/user-search/genai:%build.vcs.number% services/genai
  docker push artifactory.example.com/user-search/genai:%build.vcs.number%

Step 2 — EKS rollout
  kubectl set image deployment/user-search-app app=artifactory.example.com/user-search/app:%build.vcs.number%
  kubectl set image deployment/user-search-genai genai=artifactory.example.com/user-search/genai:%build.vcs.number%

Step 3 — Package Lambda functions
  cdk synth

Step 4 — Deploy Lambda functions
  cdk deploy --require-approval never
  # 6 functions: etl-ad-line, etl-netforum-line, etl-eu-line, etl-dg-line, etl-m365-line, etl-sp-line
```

---

## Infrastructure as Code

### Recommended: AWS SAM or CDK

For the Lambda + EventBridge + RDS Proxy stack, AWS SAM provides the simplest path:

```yaml
# template.yaml (SAM)
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Runtime: nodejs22.x
    Timeout: 900        # 15 min max
    MemorySize: 2048
    VpcConfig:
      SecurityGroupIds: [!Ref LambdaSG]
      SubnetIds: !Ref PrivateSubnets
    Layers:
      - !Ref SBERTModelLayer

Resources:
  SBERTModelLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      ContentUri: layers/sbert-model/
      CompatibleRuntimes: [nodejs22.x]

  EtlAdLineFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      CodeUri: services/etl-ad-line/
      Events:
        HourlySchedule:
          Type: Schedule
          Properties:
            Schedule: rate(1 hour)
      Environment:
        Variables:
          S3_BUCKET: !Ref DataBucket
          S3_PREFIX: etl-ad-line
          RDS_PROXY_ENDPOINT: !GetAtt RDSProxy.Endpoint

  # ... repeat for etl-netforum-line, etl-eu-line, etl-dg-line, etl-m365-line, etl-sp-line

  DataBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: user-search-data

  # App and GenAI services are deployed to EKS via Helm charts or raw kubectl manifests.
  # Kubernetes manifests live in k8s/ — see Phase 3 and Phase 5.
  # Images are pulled from Artifactory (imagePullSecrets configured in the cluster).
  # No ECS/Fargate resources are required.
```

---

## Phase 5 — GenAI Agent Service

**Goal:** Migrate the GenAI agent service (Ollama + Express) to AWS.

The GenAI service currently runs as two containers: a Node.js Express app (`services/genai`) and an Ollama sidecar serving the `qwen2.5:3b` model (**local development only — not suitable for production use**). The agent uses LLM tool-calling to execute 6 action types (provision, disable, reset password, update attribute, add to group, add to M365 group) with auto-closing tickets.

> **Note on LLM selection for AWS:** The choice of `qwen2.5:3b` was made for local development convenience (small footprint, runs on CPU). Any AWS deployment must include a formal review of available LLMs against the workload's cost and performance requirements before a model is selected. The options below identify candidate models, but the final model choice should be validated against token throughput, tool-calling accuracy, latency, and cost-per-request for this specific agent workload.

### Option A — Amazon Bedrock (Recommended)

Replace Ollama with Amazon Bedrock’s managed LLM API. This eliminates GPU infrastructure management.

| Concern | Detail |
|---|---|
| Model | **To be determined via LLM review** — candidate models with native tool-calling: Anthropic Claude 3 Haiku (low cost), Claude 3.5 Sonnet (higher accuracy), Amazon Nova Pro, or Cohere Command R+. Evaluate on: tool-calling accuracy for this agent's 9 tools, latency, and cost per request before selecting. |
| Tool-calling | Bedrock supports native tool/function-calling via `converse` API |
| Code change | Replace `chatWithOllamaTools()` to call Bedrock `converse` API instead of Ollama `/api/chat` |
| Infrastructure | GenAI service runs on an EKS pod (no GPU node needed); Bedrock is a managed API |
| Cost | Pay-per-token; no idle compute |
| Cold start | None — Bedrock is always warm |

**Code change required in `services/genai/index.js`:**
```js
// Replace chatWithOllamaTools() with:
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

async function chatWithBedrockTools(messages, tools) {
  const command = new ConverseCommand({
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    messages,
    toolConfig: { tools },
  });
  const response = await bedrock.send(command);
  return response.output.message;
}
```

### GenAI Kubernetes Manifest

```yaml
# k8s/genai-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-search-genai
  namespace: user-search
spec:
  replicas: 1
  selector:
    matchLabels:
      app: user-search-genai
  template:
    metadata:
      labels:
        app: user-search-genai
    spec:
      imagePullSecrets:
        - name: artifactory-pull-secret
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: genai
          image: artifactory.example.com/user-search/genai:latest
          ports:
            - containerPort: 3001
          env:
            - name: PORT
              value: "3001"
          envFrom:
            - secretRef:
                name: user-search-genai-secret   # DATABASE_URL, API_KEY, OLLAMA_URL / BEDROCK config
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: user-search-genai
  namespace: user-search
spec:
  selector:
    app: user-search-genai
  ports:
    - port: 3001
      targetPort: 3001
```

Configure Bedrock credentials via IRSA — the pod's service account maps to an IAM role with `bedrock:InvokeModel` permission. No Ollama sidecar needed.

### App → GenAI Networking

The app service proxies `/api/agent` and `/api/tickets` to the GenAI service. Within EKS, Kubernetes Service DNS handles this automatically:

```
App pod → Kubernetes Service DNS (user-search-genai.user-search.svc.cluster.local:3001)
        → GenAI pod
```

Set `GENAI_URL=http://user-search-genai:3001` in the app deployment — no Cloud Map or external discovery needed within the same cluster and namespace.

---

## Security Considerations for AWS

| Area | Local (current) | AWS (target) |
|---|---|---|
| DB credentials | `PGPASSWORD \|\| 'postgres'` fallback | Secrets Manager only; remove hardcoded fallback |
| API key | Hardcoded `dev-key-please-change` | Secrets Manager; rotate regularly |
| Container user | Runs as root (no `USER node`) | Set `USER node` in all Dockerfiles; enforce `runAsNonRoot: true` and `runAsUser: 1000` in EKS pod security context |
| Network | Docker bridge network | VPC private subnets; no public DB access |
| TLS | None (HTTP on localhost) | ACM cert on ALB; RDS enforces SSL |
| IAM | OIDC role for CI | Execution roles per Lambda; IRSA pod role per EKS workload; Bedrock invoke-model permission |
| Data at rest | Unencrypted Docker volume | RDS: KMS encryption; S3: SSE-S3 or SSE-KMS |
| SQL injection | `target_system` validated server-side (`VALID_SYSTEMS`); `field` validated (`ALLOWED_FIELDS`); LIKE wildcards escaped | Maintain these guards; add table whitelist to ETL `truncate()` |
| Agent actions | LLM tool-calling executes real DB mutations | Rate limit `POST /api/agent`; ensure Bedrock model respects tool schema constraints |
| Ticket ownership | `PATCH /api/tickets/:id` requires email match | Add SAML session identity as source of truth (replace client-supplied email) |
| Prompt injection | System prompt contains schema details | For production: abstract table names, add guardrails against instruction extraction |

### Pre-Migration Security Checklist

- [ ] Remove `|| 'postgres'` fallback from all `vectorize.js` files
- [ ] Add `USER node` to all Dockerfiles (app + genai images) and set `runAsNonRoot: true` in EKS pod security contexts
- [ ] Add table name whitelist to `truncate()` function
- [x] Add `target_system` server-side validation in agent executors (done — `validateTargetSystem()`)
- [x] Escape LIKE wildcards in group name searches (done — `escapeLike()`)
- [x] Add ticket ownership check to PATCH endpoint (done — `WHERE email = $3`)
- [ ] Add rate limiting to `POST /api/agent` (`express-rate-limit`)
- [ ] Enable RDS SSL enforcement (`rds.force_ssl = 1`)
- [ ] Create per-function IAM execution roles (least privilege)
- [ ] Grant Bedrock `InvokeModel` permission to the GenAI pod IRSA role (if using Option A)
- [ ] Enable S3 bucket versioning and server-side encryption
- [ ] Set up CloudWatch alarms for Lambda errors, EKS pod restarts, and agent error rates
- [ ] Implement SAML-based identity for agent actions (see [saml-access-management.md](saml-access-management.md))

See [findings4.md](../security/findings4.md) for the full agent-specific security review.

---

## Cost Estimate (Rough)

### Option A — Bedrock (Recommended)

| Service | Configuration | Monthly Est. |
|---|---|---|
| RDS PostgreSQL | db.t3.medium, Multi-AZ, 20 GB gp3 | ~$70 |
| RDS Proxy | 1 proxy | ~$22 |
| Lambda (6 functions) | 1 invocation/hr × 6, ~60s each, 2048 MB | ~$3 |
| EKS cluster | 1 cluster (control plane) | ~$73 |
| EKS node group (app + genai) | 2× t3.medium, on-demand | ~$61 |
| ALB | 1 ALB + LCUs (via Ingress) | ~$22 |
| Bedrock | Claude 3 Haiku, ~50k tokens/day | ~$15 |
| S3 | <1 GB data | ~$0.03 |
| Secrets Manager | 3 secrets | ~$1.50 |
| **Total** | | **~$268/mo** |

### Option B — EKS with GPU Node (Self-Hosted Ollama)

| Service | Configuration | Monthly Est. |
|---|---|---|
| All of the above except Bedrock | | ~$253 |
| EC2 GPU node (g5.xlarge) | 1 GPU node in EKS node group for Ollama | ~$730 |
| **Total** | | **~$983/mo** |

### Option C — Fully Serverless (Lambda + Bedrock)

| Service | Configuration | Monthly Est. |
|---|---|---|
| RDS PostgreSQL | db.t3.medium, Multi-AZ, 20 GB gp3 | ~$70 |
| RDS Proxy | 1 proxy | ~$22 |
| Lambda (6 ETL + app + genai) | 8 functions total; app/genai scale to zero | ~$9 |
| API Gateway | REST API fronting app Lambda | ~$10 |
| Bedrock | Claude 3 Haiku, ~50k tokens/day | ~$15 |
| S3 | <1 GB data | ~$0.03 |
| Secrets Manager | 3 secrets | ~$1.50 |
| **Total** | | **~$127/mo** |

---

## Migration Order

```
1. RDS (Phase 1)              — standalone, no code changes required
2. App → EKS (Phase 3)        — point DATABASE_URL at RDS, push image to Artifactory, deploy Kubernetes manifests
3. GenAI → EKS (Phase 5)      — deploy genai pod to EKS, swap Ollama for Bedrock (Option A) or add GPU node (Option B)
4. Data → S3 (Phase 4)        — upload JSON files
5. ETL → Lambda (Phase 2)     — refactor vectorize.js, deploy 6 functions
6. Decommission Docker Compose for prod (keep for local dev)
```

Phase 2 (Lambda) is listed last because it requires the most code changes. The app can migrate to EKS with zero code changes — only the `DATABASE_URL` environment variable needs to point at RDS and the image URL updated to the Artifactory path. The GenAI service requires swapping `chatWithOllamaTools()` for a Bedrock API call (Option A) or deploying with a GPU-backed node (Option B). For a fully serverless deployment, both the app and GenAI service can alternatively be wrapped with `serverless-http` and deployed as Lambda zip packages (Option C — see Phase 3 and Phase 5 for details).
