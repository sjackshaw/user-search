# Benefits and Implementation Cost

---

## Expected Benefits

### 1. Operational Time Savings

The primary benefit is the elimination of multi-team coordination overhead. Based on the inputs from [problem.md](problem.md):

| Metric | Assumption | Annual Impact |
|---|---|---|
| Cross-system requests | 10/week (conservative midpoint of 6–20) | 520 issues/year |
| Current resolution time | 2.5 hours average (range: 1–4 hours) | 1,300 person-hours/year |
| Resolution time with platform | 20–30 minutes (single analyst, single session) | ~225 person-hours/year |
| **Time recovered** | | **~1,075 person-hours/year** |

> These hours represent coordination and handoff time — the cost of navigating the structure of the problem, not resolving it. Recovered time returns directly to the teams currently spending it.

### 2. Delivery Team Focus

Delivery teams are currently interrupted multiple times per week to assist with user support requests. With first-line support able to resolve issues independently:

| Metric | Current | With platform |
|---|---|---|
| Delivery interruptions | 3–4 per week | Near zero for routine user issues |
| Context-switch recovery | ~20 min per interruption | Not incurred |
| **Recovered focus time** | | **~50–60 hours/year per delivery team member** |

For a delivery team of five, this is approximately 250–300 hours of recovered project time per year — hours currently lost to context switching, not to the support requests themselves.

### 3. Lifecycle Operations (Onboarding and Offboarding)

The platform's lifecycle management tools replace multi-step, multi-team processes with single agent instructions:

| Process | Current | With platform |
|---|---|---|
| New hire onboarding | Provision AD, netForum, assign license, add to groups — each step by a different team | `onboard_user` — single instruction, all steps in one action |
| Departure offboarding | Disable accounts, remove groups, revoke SharePoint, reclaim license — coordinated across teams | `offboard_user` — single instruction, full workflow |
| Post-disable cleanup | Manual follow-up to check group/permission residue | `deprovision_cascade` — automatic on request |

At even a modest volume — say 5 onboardings and 5 offboardings per month — the reduction in coordination effort across these structured workflows compounds the time savings above.

### 4. Access Hygiene and License Recovery

The governance tools provide ongoing value beyond reactive support:

| Tool | What it surfaces | Potential saving |
|---|---|---|
| `list_inactive_licenses` | M365 licenses held by users inactive for >90 days | Each reclaimed E3 license saves ~$36/month; even 5–10 recovered licences covers a significant portion of infrastructure cost |
| `list_stale_guests` | Guest accounts inactive beyond a threshold | Reduces access risk and compliance exposure |
| `list_app_consents` / `revoke_app_consent` | OAuth grants to third-party apps | Reduces shadow IT risk |
| `get_device_compliance` / `explain_ca_block` | Compliance gaps and access blocks | Eliminates escalation tickets for "why can't I log in" queries |

These are currently manual, periodic checks — if done at all. With the platform, any analyst can run them on demand.

### 5. Audit and Accountability

Every agent write action and sensitive read creates an auditable record. Currently, changes made across systems are logged per system with no consolidated view.

| Aspect | Current | With platform |
|---|---|---|
| Change history | Siloed per system | Single cross-source timeline per user |
| Agent action audit | Not applicable | Every write action creates a ticket (auto-closed on success) |
| Access requests | Ad hoc email/Slack | Structured request → approval → execution with full trail |
| Who made a change | Requires checking each system separately | `source_change_logs` table, queryable by analyst or agent |

---

## Implementation Cost

### Engineering Effort

Production readiness requires three workstreams. All are fully documented with implementation guides in this repository.

| Workstream | Scope | Estimate |
|---|---|---|
| **1. Real data connections** | Replace synthetic JSON with live API feeds: Microsoft Graph (AD, M365, Exchange, Distribution Groups, SharePoint) + netForum REST. Graph integration is already wired — credentials and endpoint mapping needed. | 3–5 weeks |
| **2. Cloud deployment** | Provision AWS infrastructure (RDS, EKS or Lambda, Secrets Manager, ALB), update CI/CD pipeline, validate all services. Full migration plan documented. | 4–6 weeks |
| **3. Authentication and access control** | SAML SSO via Entra ID, role-based access enforcement across all 37 agent tools, role management UI for admins. Plan fully documented. | 3–4 weeks |

**Total elapsed time (single engineer):** 10–15 weeks  
**Total elapsed time (two engineers in parallel):** 6–9 weeks

A fourth workstream — connecting agent write actions to live APIs (Microsoft Graph for M365 actions, netForum REST for member provisioning) and routing tickets through ServiceNow/Jira — is scoped as a subsequent phase:

| Workstream | Scope | Estimate |
|---|---|---|
| **4. Production agent actions + ITSM** | Swap PoC Postgres write operations for real API calls per system; connect `agent_tickets` and `access_requests` to ServiceNow or Jira. | 4–6 weeks |

> **Note:** Microsoft Graph actions (MFA, licenses, mailbox, Teams, OneDrive, governance) are already wired in the code and switch to live operation automatically when Entra ID credentials are supplied. The bulk of Workstream 4 is the AD/netForum provisioning path and ITSM integration.

### Infrastructure Cost (Annual)

| Deployment option | Monthly | Annual |
|---|---|---|
| **EKS + Bedrock (primary — recommended)** | ~$295 | ~$3,540 |
| **Lambda + Bedrock (fallback, if EKS unavailable)** | ~$234 | ~$2,808 |

Cost breakdown: Amazon RDS (Multi-AZ), EKS shared node group (App + GenAI + ETL), ALB, Amazon Bedrock (~50k tokens/day), S3, Secrets Manager. Full breakdown in [aws-migration-plan.md](../next-steps/aws-migration-plan.md).

---

## Return on Investment

Without applying a cost-per-hour figure (not available), the break-even is expressed in time:

> If the **1,075 hours recovered annually** from handoff elimination represents staff time that would otherwise be spent on coordination — and assuming those hours have any material value — the infrastructure cost of **~$3,540/year** is recovered within the first few weeks of operation.

The engineering investment (10–15 weeks single engineer) is the substantive cost. That pays for:

- A production-ready platform serving 20,000+ identities
- 37 automated service desk actions covering the majority of routine requests
- A foundation reusable for member search and other data consolidation domains

To apply a hard figure: at a blended engineering day rate of £X, the total investment is calculable from the week estimates above. That figure can be compared against the hourly cost of the staff time currently absorbed by coordination.

---

## Summary

| | Value |
|---|---|
| **Staff hours recovered (coordination)** | ~1,075/year |
| **Delivery focus recovered** | ~250–300 hours/year across a 5-person delivery team |
| **Infrastructure cost** | ~$3,540/year (EKS + Bedrock) |
| **Engineering to production** | 10–15 weeks (single engineer) · 6–9 weeks (two engineers) |
| **Secondary benefit** | License recovery, access hygiene, consolidated audit trail |
| **Strategic benefit** | Reusable architecture for member search and further data consolidation |

*See [solution.md](solution.md) for the full technical solution and [problem.md](problem.md) for the quantified problem statement.*
