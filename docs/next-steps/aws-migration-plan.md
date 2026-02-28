# AWS Cloud Migration Plan

## Current State — Local Docker Demo

| Component | Technology | Details |
|---|---|---|
| Database | PostgreSQL 15 + pgvector (Docker) | 12+ tables (user sources, logs, `agent_tickets`, `chat_messages`, `m365_group_memberships`), HNSW indexes, bind-mounted data dir |
| ETL | 6 Docker line containers (node:22) | AD, NetForum, External Users, Distribution Groups, M365, SharePoint. Cron-scheduled (hourly), SBERT `Xenova/all-MiniLM-L6-v2`, shared model cache volume |
| App | Docker container (node:22, Express) | Port 3000, SBERT at query time, cosine similarity search, proxies agent/ticket requests to GenAI service |
| GenAI | Docker container (node:22, Express) + Ollama sidecar | Port 3001, LLM tool-calling agent (`qwen2.5:3b`), 9 tools, 6 action executors, cross-system provisioning, M365 group management |
| Orchestration | Docker Compose (9 YAML fragments) | `npm run dev:up` brings up full stack |
| CI | GitHub Actions → ECR push | OIDC auth, matrix build for images |

## Target State — AWS Production

| Component | AWS Service | Details |
|---|---|---|
| Database | **Amazon RDS** (PostgreSQL 15 + pgvector) | Multi-AZ, encrypted at rest, Secrets Manager for credentials |
| ETL | **AWS Lambda** (6 functions) | EventBridge scheduled, reads from S3, writes to RDS |
| App | **AWS Fargate** (ECS) | ALB fronted, auto-scaling, ECR image |
| GenAI agent | **Amazon Bedrock** or **AWS Fargate** (ECS) | See Phase 5 below; replaces Ollama with managed LLM or GPU-backed container |
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
| 1.1 | Create RDS PostgreSQL 15 instance with `pgvector` extension enabled |
| 1.2 | Run `infra/db/init/01_create_schema.sql` through `15_agent_tickets.sql` against RDS |
| 1.3 | Store RDS credentials in Secrets Manager (already set up for CI) |
| 1.4 | Update app and GenAI service `DATABASE_URL` to point to RDS endpoint |
| 1.5 | Update ETL `PGHOST`/`PGPASSWORD` env vars to use Secrets Manager |
| 1.6 | Remove `docker-compose.postgres.yml` from `dev:up` (or keep for local dev) |

**RDS Configuration:**
```
Engine:            PostgreSQL 15
Instance class:    db.t3.medium (start), scale as needed
Storage:           gp3, 20 GB (HNSW indexes are ~60 MB for 14k records)
Multi-AZ:          Yes (production)
Encryption:        KMS default key
VPC:               Private subnets only
Security group:    Allow 5432 from Lambda SG + Fargate SG (app + genai)
Parameter group:   shared_preload_libraries = 'vector'
```

**pgvector on RDS:** pgvector is available as an extension on RDS PostgreSQL 15.4+. Enable with:
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

### Phase 3 — App (Fargate)

**Goal:** Run the Express app on ECS Fargate behind an ALB.

#### ECS Task Definition

```json
{
  "family": "user-search-app",
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [{
    "name": "app",
    "image": "<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/app:latest",
    "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT", "value": "3000" },
      { "name": "TOP_K", "value": "20" }
    ],
    "secrets": [{
      "name": "DATABASE_URL",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:user-search-db"
    }],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/user-search-app",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "app"
      }
    }
  }]
}
```

#### Key Fargate Considerations

| Concern | Detail |
|---|---|
| SBERT model | Still loaded at container startup (~5s); fine for Fargate since container stays warm |
| Health check | ALB target group health check on `GET /` (returns HTML) or add `GET /health` |
| Auto-scaling | Target tracking on CPU or request count; min 1, max 4 tasks |
| Image | Same Dockerfile, already built and pushed to ECR by CI |
| Networking | Private subnet, ALB in public subnet, security group allows 3000 from ALB only |
| DATABASE_URL | Injected from Secrets Manager (already in CI) |
| GENAI_URL | Set to GenAI Fargate service endpoint via Cloud Map (e.g. `http://genai.user-search.local:3001`) |
| Agent proxy | App proxies `/api/agent`, `/api/tickets` to GenAI service — networking must allow app → genai on port 3001 |

#### ALB + Route 53

```
Internet → Route 53 (user-search.example.com)
         → ALB (HTTPS:443, ACM cert)
         → Target Group (port 3000)
         → Fargate tasks (private subnet)
```

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
Push → GitHub Actions → Test (compose + Jest) → Build images → Push to ECR
```

### Target Pipeline
```
Push → GitHub Actions → Test (RDS + Jest)
                      → Build app image → Push to ECR → Deploy Fargate service
                      → Package Lambda → Deploy Lambda functions (SAM/CDK)
```

| Change | Detail |
|---|---|
| Test job | Point `DATABASE_URL` at RDS (already configured in CI via Secrets Manager) |
| App deploy | Add ECS service update step: `aws ecs update-service --force-new-deployment` |
| Lambda deploy | Use AWS SAM (`sam build && sam deploy`) or CDK; upload to S3, update function code |
| Remove ECR push for ETL | Lambda functions are deployed as zip packages, not Docker images |
| Add S3 sync step | Upload `data/*.json` files to S3 bucket if synthetic data changed |

### Updated CI Matrix

The `build-and-push` job matrix changes to building 2 images (app + genai) + deploying 6 Lambda functions:

```yaml
# Fargate images
- name: app
  path: services/app
  repo: app
- name: genai
  path: services/genai
  repo: genai    # only if running Ollama on Fargate; omit if using Bedrock

# Lambda functions (zip deploy, not Docker)
# Handled by a separate SAM/CDK deploy job
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

  AppFargateService:
    # ECS Cluster, Task Definition, Service, ALB defined here

  GenAiFargateService:
    # Only if running Ollama on ECS; omit if using Bedrock
    # Requires GPU instance type (g5.xlarge) or Bedrock API calls
```

---

## Phase 5 — GenAI Agent Service

**Goal:** Migrate the GenAI agent service (Ollama + Express) to AWS.

The GenAI service currently runs as two containers: a Node.js Express app (`services/genai`) and an Ollama sidecar serving the `qwen2.5:3b` model. The agent uses LLM tool-calling to execute 6 action types (provision, disable, reset password, update attribute, add to group, add to M365 group) with auto-closing tickets.

### Option A — Amazon Bedrock (Recommended)

Replace Ollama with Amazon Bedrock’s managed LLM API. This eliminates GPU infrastructure management.

| Concern | Detail |
|---|---|
| Model | Bedrock tool-calling models: Anthropic Claude 3, Amazon Titan, or Cohere Command R+ |
| Tool-calling | Bedrock supports native tool/function-calling via `converse` API |
| Code change | Replace `chatWithOllamaTools()` to call Bedrock `converse` API instead of Ollama `/api/chat` |
| Infrastructure | GenAI service runs on Fargate (no GPU needed); Bedrock is a managed API |
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

### Option B — ECS Fargate with GPU (Self-Hosted Ollama)

Run Ollama on a GPU-backed ECS task alongside the GenAI Express service.

| Concern | Detail |
|---|---|
| Instance type | `g5.xlarge` (1× NVIDIA A10G, 24 GB VRAM) — via ECS capacity provider |
| Model | `qwen2.5:3b` (~2 GB VRAM) fits easily; room to scale to larger models |
| Cost | ~$1.01/hr (~$730/mo) for the GPU instance; significantly more expensive than Bedrock |
| Benefit | Full control over model, no per-token cost, supports any Ollama model |
| Drawback | Idle compute cost, GPU instance management, slower scaling |

**Recommendation:** Option A (Bedrock) for production. Option B only if the organisation requires a self-hosted model for data sovereignty or cost predictability at high volume.

### GenAI Fargate Task Definition (shared for both options)

```json
{
  "family": "user-search-genai",
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [{
    "name": "genai",
    "image": "<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/genai:latest",
    "portMappings": [{ "containerPort": 3001, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT", "value": "3001" }
    ],
    "secrets": [
      { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:..." },
      { "name": "API_KEY", "valueFrom": "arn:aws:secretsmanager:..." }
    ]
  }]
}
```

For Option A, set `OLLAMA_URL` to the Bedrock adapter (or refactor the code to call Bedrock directly). For Option B, add an Ollama sidecar container to the task definition.

### App → GenAI Networking

The app service proxies `/api/agent` and `/api/tickets` to the GenAI service. In AWS:

```
App Fargate task → GenAI Fargate task (internal ALB or Cloud Map service discovery)
```

Use **AWS Cloud Map** for service discovery so the app can resolve `genai.user-search.local:3001` without hardcoding IPs.

---

## Security Considerations for AWS

| Area | Local (current) | AWS (target) |
|---|---|---|
| DB credentials | `PGPASSWORD \|\| 'postgres'` fallback | Secrets Manager only; remove hardcoded fallback |
| API key | Hardcoded `dev-key-please-change` | Secrets Manager; rotate regularly |
| Container user | Runs as root (no `USER node`) | Fargate runs as non-root by default when `USER` set; enforce in task def |
| Network | Docker bridge network | VPC private subnets; no public DB access |
| TLS | None (HTTP on localhost) | ACM cert on ALB; RDS enforces SSL |
| IAM | OIDC role for CI | Execution roles per Lambda + Fargate task role; Bedrock invoke-model permission |
| Data at rest | Unencrypted Docker volume | RDS: KMS encryption; S3: SSE-S3 or SSE-KMS |
| SQL injection | `target_system` validated server-side (`VALID_SYSTEMS`); `field` validated (`ALLOWED_FIELDS`); LIKE wildcards escaped | Maintain these guards; add table whitelist to ETL `truncate()` |
| Agent actions | LLM tool-calling executes real DB mutations | Rate limit `POST /api/agent`; ensure Bedrock model respects tool schema constraints |
| Ticket ownership | `PATCH /api/tickets/:id` requires email match | Add SAML session identity as source of truth (replace client-supplied email) |
| Prompt injection | System prompt contains schema details | For production: abstract table names, add guardrails against instruction extraction |

### Pre-Migration Security Checklist

- [ ] Remove `|| 'postgres'` fallback from all `vectorize.js` files
- [ ] Add `USER node` to all Dockerfiles (Fargate app + genai images)
- [ ] Add table name whitelist to `truncate()` function
- [x] Add `target_system` server-side validation in agent executors (done — `validateTargetSystem()`)
- [x] Escape LIKE wildcards in group name searches (done — `escapeLike()`)
- [x] Add ticket ownership check to PATCH endpoint (done — `WHERE email = $3`)
- [ ] Add rate limiting to `POST /api/agent` (`express-rate-limit`)
- [ ] Enable RDS SSL enforcement (`rds.force_ssl = 1`)
- [ ] Create per-function IAM execution roles (least privilege)
- [ ] Grant Bedrock `InvokeModel` permission to GenAI task role (if using Option A)
- [ ] Enable S3 bucket versioning and server-side encryption
- [ ] Set up CloudWatch alarms for Lambda errors, Fargate health, and agent error rates
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
| Fargate (app) | 0.5 vCPU, 1 GB, 1 task (min) | ~$18 |
| Fargate (genai) | 0.25 vCPU, 0.5 GB, 1 task | ~$9 |
| ALB | 1 ALB + LCUs | ~$22 |
| Bedrock | Claude 3 Haiku, ~50k tokens/day | ~$15 |
| S3 | <1 GB data | ~$0.03 |
| Secrets Manager | 3 secrets | ~$1.50 |
| **Total** | | **~$161/mo** |

### Option B — Self-Hosted Ollama (GPU)

| Service | Configuration | Monthly Est. |
|---|---|---|
| All of the above except Bedrock | | ~$146 |
| EC2 GPU (g5.xlarge) | 1 instance for Ollama | ~$730 |
| **Total** | | **~$876/mo** |

---

## Migration Order

```
1. RDS (Phase 1)              — standalone, no code changes required
2. App → Fargate (Phase 3)    — point DATABASE_URL at RDS, deploy image
3. GenAI → Fargate (Phase 5)  — deploy genai service, swap Ollama for Bedrock (or add GPU sidecar)
4. Data → S3 (Phase 4)        — upload JSON files
5. ETL → Lambda (Phase 2)     — refactor vectorize.js, deploy 6 functions
6. Decommission Docker Compose for prod (keep for local dev)
```

Phase 2 (Lambda) is listed last because it requires the most code changes. The app can migrate to Fargate with zero code changes — only the `DATABASE_URL` environment variable needs to point at RDS. The GenAI service requires swapping `chatWithOllamaTools()` for a Bedrock API call (Option A) or adding a GPU sidecar (Option B).
