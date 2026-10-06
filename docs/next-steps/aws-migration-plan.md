# AWS Cloud Migration Plan

## Current State — Local Docker Demo

| Component | Technology | Details |
|---|---|---|
| Database | PostgreSQL 18 + pgvector (Docker) | 20 tables (user sources, logs, `agent_tickets`, `chat_messages`, `m365_group_memberships`, `governance_violations`, `scheduled_reports`, `policy_rules`), HNSW indexes, bind-mounted data dir |
| ETL | 6 Docker line containers (node:22) | AD, NetForum, External Users, Distribution Groups, M365, SharePoint. Cron-scheduled (hourly), SBERT `Xenova/all-MiniLM-L6-v2`, shared model cache volume |
| App | Docker container (node:22, Express) | Port 3000, SBERT at query time, cosine similarity search, proxies agent/ticket requests to GenAI service |
| GenAI | Docker container (node:22, Express) + Ollama sidecar | Port 3001, LLM tool-calling agent (`qwen2.5:3b` — **local dev only**), 57 tools, lifecycle management, access requests, governance detection/remediation, policy rule engine, compliance reporting, M365 Graph integration |
| Orchestration | Docker Compose (9 YAML fragments) | `npm run dev:up` brings up full stack |
| CI | TeamCity → Artifactory push | Matrix build for images, triggered on merge |

## Target State — AWS Production

| Component | AWS Service | Details |
|---|---|---|
| Database | **Amazon RDS** (PostgreSQL 18 + pgvector) | Multi-AZ, encrypted at rest, Secrets Manager for credentials |
| ETL | **Amazon EKS** (6 Deployments or CronJobs, shared node group) — **Lambda (6 functions, native Node.js)** if EKS not available | EKS primary: containerised ETL pods on shared cluster, node-cron schedule, Artifactory images. Lambda fallback: EventBridge scheduled, zip packages, reads from S3 |
| App | **Amazon EKS** (EC2 node group) — **Lambda (native Node.js handler)** if EKS not available | EKS primary: ALB Ingress Controller, HPA auto-scaling, Artifactory image. Lambda fallback: native Node.js Lambda handler + API Gateway, zip package |
| GenAI agent | **Amazon Bedrock** | See Phase 5 below; replaces Ollama with managed Bedrock LLM API |
| Model cache | **Shared EKS pod volume** (EKS) or **Lambda Layer** (Lambda fallback) | SBERT model weights (~80 MB) |
| Data source | **Amazon S3** | `primary.json` and `logs.json` per data line |
| Scheduling | **Kubernetes CronJob schedule** (EKS) or **Amazon EventBridge** (Lambda fallback) | Replaces `node-cron`; hourly cadence |
| Secrets | **AWS Secrets Manager** | Already referenced in CI; extends to runtime |
| DNS / TLS | **Route 53 + ACM** | HTTPS termination at ALB (EKS) or API Gateway custom domain (Lambda) |

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
| 1.2 | Run `infra/db/init/01_create_schema.sql` through `24_remediation_proposals.sql` in filename order against RDS |
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

### Phase 2 — ETL (EKS)

**Goal:** Run the 6 ETL line containers on the same Amazon EKS cluster as the App and GenAI service. ETL pods share the managed node group, pull images from Artifactory, and read source data from S3 — matching the App's deployment pattern.

#### Primary: EKS Deployment (minimal code changes)

The simplest migration keeps the existing `node-cron` schedule inside a long-running Deployment pod — identical to how the service runs in Docker Compose today. The only code changes are the data source (file → S3) and database connection (hardcoded host → RDS Proxy endpoint via Secrets Manager).

**Key Architecture Changes**

| Concern | Docker (current) | EKS (target) |
|---|---|---|
| Runtime | Long-running container + `node-cron` | Long-running Deployment pod + `node-cron` (unchanged) |
| Model loading | Once at startup, reused across cron ticks | Same — pod stays warm between cron ticks |
| Data source | `data/primary.json` mounted into container | S3 bucket (`s3://user-search-data/etl-ad-line/primary.json`) |
| Connection pool | Persistent `pg.Pool` | RDS Proxy endpoint (connection pooling) |
| Scheduling | `node-cron` in process | `node-cron` in process (unchanged); or migrate to EKS CronJob (see alternative below) |
| Image registry | Local Docker build | Artifactory (`artifactory.example.com/user-search/etl-ad-line:latest`) |

**vectorize.js changes required (same regardless of EKS or Lambda):**

| Current code | Change needed |
|---|---|
| `fs.readFileSync('data/primary.json')` | Read from S3 (`GetObjectCommand`) |
| `new Pool({ host: 'postgres' })` | Use RDS Proxy endpoint + IAM auth or Secrets Manager |
| `process.exit(1)` on fatal | Throw error (container restarts via `restartPolicy: Always`) |

**Kubernetes Manifest (one per ETL line):**

```yaml
# k8s/etl-ad-line-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: etl-ad-line
  namespace: user-search
spec:
  replicas: 1
  selector:
    matchLabels:
      app: etl-ad-line
  template:
    metadata:
      labels:
        app: etl-ad-line
    spec:
      imagePullSecrets:
        - name: artifactory-pull-secret
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: etl
          image: artifactory.example.com/user-search/etl-ad-line:latest
          env:
            - name: S3_BUCKET
              value: user-search-data
            - name: S3_PREFIX
              value: etl-ad-line
            - name: CRON_SCHEDULE
              value: "0 * * * *"
            - name: BATCH_SIZE
              value: "64"
          envFrom:
            - secretRef:
                name: user-search-db-secret   # DATABASE_URL
          resources:
            requests:
              cpu: "250m"
              memory: "768Mi"    # SBERT model ~400 MB + process overhead
            limits:
              cpu: "500m"
              memory: "1.5Gi"
          readinessProbe:
            exec:
              command: ["node", "-e", "process.exit(0)"]
            initialDelaySeconds: 30
            periodSeconds: 60
```

Repeat for `etl-netforum-line`, `etl-eu-line`, `etl-dg-line`, `etl-m365-line`, `etl-sp-line`.

#### Alternative: EKS CronJob (Kubernetes-native scheduling)

For a cleaner resource footprint, convert each ETL service to a Kubernetes CronJob that starts a pod on schedule, runs to completion, and terminates. This removes `node-cron` from the service entirely and lets Kubernetes manage the schedule.

| Concern | Deployment + node-cron | CronJob |
|---|---|---|
| Resource use | Pod runs continuously, idles between ticks | Pod only exists during execution |
| Code change | Minimal (only S3 + DB connection) | Remove `node-cron`; add run-and-exit `main()` handler |
| Cold start | None (model cached in warm pod) | Model loads each run (~5–10s) |
| Missed runs | node-cron handles in-process | CronJob: `concurrencyPolicy: Forbid` prevents overlap |

```yaml
# k8s/etl-ad-line-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etl-ad-line
  namespace: user-search
spec:
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          imagePullSecrets:
            - name: artifactory-pull-secret
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
          containers:
            - name: etl
              image: artifactory.example.com/user-search/etl-ad-line:latest
              command: ["node", "vectorize.js", "--run-once"]
              envFrom:
                - secretRef:
                    name: user-search-db-secret
              env:
                - name: S3_BUCKET
                  value: user-search-data
                - name: S3_PREFIX
                  value: etl-ad-line
              resources:
                requests:
                  cpu: "500m"
                  memory: "1Gi"
                limits:
                  cpu: "1000m"
                  memory: "2Gi"
```

#### Fallback: Lambda (native Node.js, if EKS not available)

If EKS cannot be provisioned, ETL falls back to 6 Lambda functions using the `nodejs22.x` runtime deployed as zip packages (no ECR, no Docker images). The same S3 + RDS Proxy + EventBridge pattern applies.

| Concern | Docker (current) | Lambda (fallback) |
|---|---|---|
| Runtime | Long-running container + `node-cron` | Event-driven invocation (EventBridge) |
| Model loading | Once at container startup | Cold start: load from Lambda Layer; warm start: reused in-memory |
| Data source | `data/primary.json` | S3 (`GetObjectCommand`) |
| Connection pool | Persistent `pg.Pool` | RDS Proxy (connection pooling, avoids Lambda connection storms) |
| Memory | ~512 MB per container | 2048 MB (`nodejs22.x`) |
| Timeout | Unlimited | Up to 15 min (sufficient for 6,000 records at 64/batch) |
| Scheduling | `node-cron` | EventBridge rule: `rate(1 hour)` |
| Deployment | Docker Compose / Artifactory image | CDK/SAM zip package — no ECR required |

**handler.js** (new file — Lambda entry point):

```js
// services/etl-ad-line/handler.js
'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { run } = require('./vectorize');  // refactored to export run()

exports.handler = async (_event) => {
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  const bucket = process.env.S3_BUCKET;
  const prefix = process.env.S3_PREFIX;

  const [primaryObj, logsObj] = await Promise.all([
    s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/primary.json` })),
    s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/logs.json` })),
  ]);

  const primary = JSON.parse(await primaryObj.Body.transformToString());
  const logs    = JSON.parse(await logsObj.Body.transformToString());

  const summary = await run({ primary, logs });
  console.log('ETL complete:', JSON.stringify(summary));
  return summary;
};
```

**SBERT model in Lambda:** Package the ONNX model files into a Lambda Layer (~80 MB). All 6 ETL functions reference the same layer.

```yaml
# SAM template excerpt (Lambda fallback only)
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
    Runtime: nodejs22.x
    Timeout: 900
    MemorySize: 2048
    Layers:
      - !Ref SBERTModelLayer
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
```

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

#### Serverless Alternative — Lambda (native Node.js handler, if EKS not available)

If EKS cannot be provisioned, the Express app falls back to a Lambda function using the `nodejs22.x` runtime deployed as a **zip package** (no container image, no ECR required). The handler translates API Gateway proxy events into the Express request/response cycle natively — **no third-party adapter library** (e.g. `serverless-http`) is used.

```js
// services/app/handler.js  (new file — Lambda entry point)
'use strict';

const http    = require('http');
const express = require('./src/app');   // app.js exports the Express app, not listen()

// Re-use server across warm invocations
let _server = null;

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (!_server) {
    _server = http.createServer(express);
    await new Promise(resolve => _server.listen(0, resolve));
  }

  // Convert API Gateway proxy event → Node.js IncomingMessage / ServerResponse
  const { statusCode, headers, body } = await forwardToServer(_server, event);
  return { statusCode, headers, body, isBase64Encoded: false };
};

async function forwardToServer(server, event) {
  const method  = event.httpMethod || 'GET';
  const path    = (event.path || '/') + (event.queryStringParameters
    ? '?' + new URLSearchParams(event.queryStringParameters).toString()
    : '');
  const headers = event.headers || {};
  const body    = event.body || '';

  return new Promise((resolve, reject) => {
    const req = Object.assign(new http.IncomingMessage(null), {
      method, url: path, headers,
    });
    req.push(body);
    req.push(null);

    const chunks = [];
    const res = new http.ServerResponse(req);
    res.write = chunk => chunks.push(chunk);
    res.end   = (chunk) => {
      if (chunk) chunks.push(chunk);
      resolve({
        statusCode: res.statusCode,
        headers:    res.getHeaders(),
        body:       Buffer.concat(chunks.map(c => Buffer.from(c))).toString(),
      });
    };

    server.emit('request', req, res);
  });
}
```

> **Note:** `services/app/src/index.js` must be split into `app.js` (exports the Express `app` object) and `index.js` (calls `app.listen()` for local/Docker use). The Lambda handler imports `app.js` so it never calls `listen()`.

| Consideration | Detail |
|---|---|
| SBERT cold start | Model loads on cold start (~5–10s); set `MemorySize: 3008` to minimise load time |
| Warm reuse | Lambda reuses execution environments; `_server` and model are cached across warm invocations |
| Deployment | Zip package via SAM/CDK — no ECR required; Artifactory can store the built artefact |
| API Gateway | REST API proxy (`{proxy+}` route) forwards all paths to the Lambda; custom domain via ACM |
| GENAI_URL | Set to the GenAI service URL (API Gateway endpoint or VPC internal URL if both are Lambda) |
| Cost | Very low for bursty/low traffic; EKS is more cost-effective at sustained load |

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

### Target Pipeline (EKS — primary)
```
Merge → TeamCity → Build app image   → Push to Artifactory → kubectl rollout restart (EKS)
                 → Build genai image → Push to Artifactory → kubectl rollout restart (EKS)
                 → Build ETL images  → Push to Artifactory → kubectl rollout restart (EKS) ×6
```

| Change | Detail |
|---|---|
| Trigger | TeamCity build configuration triggered on merge to main |
| App/GenAI/ETL deploy | Build image, push to Artifactory, then run `kubectl rollout restart deployment/<name>` for each service against the EKS cluster |
| No ECR required | All container images (app, genai, 6 ETL lines) go to Artifactory; neither the EKS path nor the Lambda fallback requires ECR |
| Add S3 sync step | Upload `data/*.json` files to S3 bucket if synthetic data changed |

### TeamCity Build Steps (EKS — primary)

```
Step 1 — Build & push container images (app + genai + 6 ETL lines)
  docker build -t artifactory.example.com/user-search/app:%build.vcs.number% services/app
  docker push artifactory.example.com/user-search/app:%build.vcs.number%

  docker build -t artifactory.example.com/user-search/genai:%build.vcs.number% services/genai
  docker push artifactory.example.com/user-search/genai:%build.vcs.number%

  # Repeat for each ETL line (etl-ad-line, etl-netforum-line, etl-eu-line, etl-dg-line, etl-m365-line, etl-sp-line)
  docker build -t artifactory.example.com/user-search/etl-ad-line:%build.vcs.number% services/etl-ad-line
  docker push artifactory.example.com/user-search/etl-ad-line:%build.vcs.number%

Step 2 — EKS rollout (app + genai + all ETL lines)
  kubectl set image deployment/user-search-app  app=artifactory.example.com/user-search/app:%build.vcs.number%
  kubectl set image deployment/user-search-genai genai=artifactory.example.com/user-search/genai:%build.vcs.number%
  kubectl set image deployment/etl-ad-line       etl=artifactory.example.com/user-search/etl-ad-line:%build.vcs.number%
  kubectl set image deployment/etl-netforum-line etl=artifactory.example.com/user-search/etl-netforum-line:%build.vcs.number%
  # ... repeat for remaining ETL lines
```

### Lambda Fallback Build Steps

If Lambda is used instead of EKS for app and ETL, replace the Docker build + kubectl steps with zip package builds and CDK/SAM deploy:

```
Step 1 — Package Lambda functions (app + 6 ETL lines)
  cd services/app   && npm ci --omit=dev && zip -r ../../dist/app-lambda.zip .
  cd services/etl-ad-line && npm ci --omit=dev && zip -r ../../dist/etl-ad-line.zip .
  # ... repeat for remaining ETL lines

Step 2 — Deploy via CDK/SAM
  cdk deploy --require-approval never
  # 7 functions: app, etl-ad-line, etl-netforum-line, etl-eu-line, etl-dg-line, etl-m365-line, etl-sp-line

Note: GenAI service is always built and pushed as a Docker image to Artifactory for EKS.
```

---

## Infrastructure as Code

### Primary — EKS (Kubernetes manifests)

For the EKS deployment, infrastructure is managed through Kubernetes manifests in `k8s/`. The RDS + RDS Proxy + Secrets Manager stack is managed by AWS CDK or CloudFormation, separate from the application manifests.

```
infra/
  cdk/
    lib/
      rds-stack.ts       # RDS + RDS Proxy + Secrets Manager
      vpc-stack.ts       # VPC, subnets, security groups
  k8s/
    namespace.yaml
    app-deployment.yaml
    app-service.yaml
    app-ingress.yaml          # ALB via AWS Load Balancer Controller
    genai-deployment.yaml
    genai-service.yaml
    etl-ad-line-deployment.yaml    # or CronJob variant
    etl-netforum-line-deployment.yaml
    etl-eu-line-deployment.yaml
    etl-dg-line-deployment.yaml
    etl-m365-line-deployment.yaml
    etl-sp-line-deployment.yaml
```

### Fallback — Lambda (AWS SAM, if EKS not available)

If EKS is unavailable, the app and all 6 ETL services deploy as native Node.js Lambda zip packages using AWS SAM. GenAI remains on EKS.

```yaml
# template.yaml (SAM — Lambda fallback for app + ETL)
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Runtime: nodejs22.x
    Timeout: 900        # 15 min max (ETL)
    MemorySize: 2048
    VpcConfig:
      SecurityGroupIds: [!Ref LambdaSG]
      SubnetIds: !Ref PrivateSubnets

Resources:
  SBERTModelLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      ContentUri: layers/sbert-model/
      CompatibleRuntimes: [nodejs22.x]

  # ── App Lambda ────────────────────────────────────────────────────────────
  AppFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      CodeUri: services/app/
      MemorySize: 3008    # large memory for SBERT warm reuse
      Layers:
        - !Ref SBERTModelLayer
      Events:
        ApiProxy:
          Type: Api
          Properties:
            Path: /{proxy+}
            Method: ANY
      Environment:
        Variables:
          DATABASE_URL: !Sub "postgresql://...@${RDSProxy.Endpoint}:5432/appdb"
          GENAI_URL: !Sub "https://${GenAIApiGateway}.execute-api.${AWS::Region}.amazonaws.com/prod"

  # ── ETL Lambdas ───────────────────────────────────────────────────────────
  EtlAdLineFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      CodeUri: services/etl-ad-line/
      Layers:
        - !Ref SBERTModelLayer
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

  # GenAI service is always deployed to EKS (see k8s/genai-deployment.yaml).
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

### Option A — EKS + Bedrock (Primary — recommended)

All services (App, GenAI, 6 ETL lines) run on a shared EKS node group. ETL pods are lightweight when idle (Deployment) or zero-cost when not running (CronJob).

| Service | Configuration | Monthly Est. |
|---|---|---|
| RDS PostgreSQL | db.t3.medium, Multi-AZ, 20 GB gp3 | ~$70 |
| RDS Proxy | 1 proxy | ~$22 |
| EKS cluster | 1 cluster (control plane) | ~$73 |
| EKS node group (app + genai + ETL) | 3× t3.medium on-demand (app + genai on 2; ETL CronJobs share remaining capacity) | ~$91 |
| ALB | 1 ALB + LCUs (via Ingress) | ~$22 |
| Bedrock | Claude 3 Haiku, ~50k tokens/day | ~$15 |
| S3 | <1 GB data | ~$0.03 |
| Secrets Manager | 3 secrets | ~$1.50 |
| **Total** | | **~$295/mo** |

> Using EKS CronJobs for ETL (pods spin up hourly, ~60s each) keeps node utilisation low — the 6 ETL pods can share 1 node with headroom for other workloads, so 3× t3.medium is sufficient for the full stack.

### Option B — EKS with GPU Node (Self-Hosted Ollama, if Bedrock unavailable)

| Service | Configuration | Monthly Est. |
|---|---|---|
| All of Option A except Bedrock | | ~$280 |
| EC2 GPU node (g5.xlarge) | 1 GPU node in EKS node group for Ollama | ~$730 |
| **Total** | | **~$1,010/mo** |

### Option C — Fully Serverless (Lambda + Bedrock fallback, if EKS not available)

| Service | Configuration | Monthly Est. |
|---|---|---|
| RDS PostgreSQL | db.t3.medium, Multi-AZ, 20 GB gp3 | ~$70 |
| RDS Proxy | 1 proxy | ~$22 |
| Lambda (6 ETL + app) | 7 functions; ETL: 1 invocation/hr × 6, ~60s, 2048 MB; App: ~500 req/day, 3008 MB | ~$12 |
| API Gateway | REST API fronting app Lambda | ~$10 |
| EKS cluster + node group (genai only) | 1 control plane + 1× t3.medium | ~$103 |
| Bedrock | Claude 3 Haiku, ~50k tokens/day | ~$15 |
| S3 | <1 GB data | ~$0.03 |
| Secrets Manager | 3 secrets | ~$1.50 |
| **Total** | | **~$234/mo** |

> GenAI remains on EKS even in the Lambda fallback because the Express agent service has persistent connections to Bedrock and Postgres that benefit from a warm pod.

---

## Migration Order

### Primary (EKS for all services)

```
1. RDS (Phase 1)                    — standalone, no code changes required
2. Data → S3 (Phase 4)              — upload JSON files; prerequisite for ETL refactor
3. App + ETL → EKS (Phases 2+3)     — both deploy to shared EKS cluster; update DATABASE_URL and S3 data source
4. GenAI → EKS (Phase 5)            — deploy genai pod, swap Ollama for Bedrock (Option A)
5. Decommission Docker Compose for prod (keep for local dev)
```

App and ETL migrate together (step 3) since they share the EKS cluster, the same Artifactory image pipeline, and the same Kubernetes deployment pattern. The app can migrate with zero code changes (only `DATABASE_URL` needs updating); ETL requires the S3 data source refactor.

### Fallback (Lambda for App + ETL, EKS for GenAI only)

```
1. RDS (Phase 1)                    — same as primary
2. Data → S3 (Phase 4)              — upload JSON files
3. ETL → Lambda (Phase 2 fallback)  — add handler.js, refactor vectorize.js for S3 + RDS Proxy, deploy via SAM
4. App → Lambda (Phase 3 fallback)  — split app.js/index.js, add native handler.js, deploy via SAM
5. GenAI → EKS (Phase 5)            — genai remains on EKS; swap Ollama for Bedrock
6. Decommission Docker Compose for prod
```
