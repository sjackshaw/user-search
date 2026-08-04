# The Problem: Fragmented User Identity Across a 20,000+ Member Organisation

---

## The Core Issue

A professional association managing **20,000+ identities** across six independent systems has no single view of a user and no single team that can resolve a cross-system issue end to end.

The six systems — Active Directory, netForum, External Users, Distribution Groups, M365 Group Memberships, and SharePoint Permissions — are each owned and maintained by different teams. They do not share a common search interface, a common change history, or a common action layer. When a support request touches more than one system, it cannot be resolved by any one team.

---

## What Happens Today

A support analyst receives a request: a user account needs provisioning, a password needs resetting, a group membership needs updating, or access needs revoking. The analyst checks the systems they have access to and identifies which other systems are involved. They then route the request to the next team — who in turn discovers the issue spans one further system, and routes again.

| Dimension | Current State |
|---|---|
| **Requests per week** | 6–20 cross-system user issues |
| **Resolution time** | 1–4 hours per issue (end to end) |
| **Teams looped in** | 2–3 teams per issue on average |
| **Delivery team interruptions** | Multiple times per week |
| **Analyst view of a user** | Manual checks across up to 6 separate systems |
| **Change history** | Siloed per system — no cross-system audit trail |

### Aggregate Impact

At a conservative 10 issues per week, each requiring 2–3 team touches and averaging 2 hours of coordination overhead:

- **~1,000 hours per year** of staff time consumed by handoff coordination alone — before any action is taken
- **~500+ delivery team interruptions per year** pulling developers and project staff off in-progress work to field or action support requests
- **Every interruption carries a context-switching cost**: research consistently puts recovery time at 15–30 minutes per context switch; at 3–4 interruptions per week across a delivery team, this compounds into hours of lost focus per week

These are coordination costs — time spent navigating the structure of the problem, not solving it.

---

## Why It Persists

The problem is structural, not behavioural. Each system is legitimate, maintained for valid reasons, and too embedded to replace. The issue is the absence of a layer that sits across them:

- **No unified search** — there is no tool that shows a user's status across all six systems from a single query
- **No cross-system context** — when a request arrives, diagnosing which systems are involved requires checking each one manually
- **No action layer** — even once diagnosed, each system requires its own team to action, their own tool, their own change process
- **No shared audit trail** — changes are logged per system; there is no consolidated view of what changed, when, and why

The result is that a routine task — provisioning an account, resetting a password, explaining why a user is blocked from an application — requires a chain of handoffs that should not exist.

---

## The Cost of the Status Quo

Without a consolidated interface, the organisation carries three compounding costs:

### 1. Operational overhead
Each cross-system issue requires 2–3 teams to coordinate. At 6–20 requests per week, the aggregate time spent on triage, routing, and follow-up is material — and grows linearly with organisation size and the number of managed systems.

### 2. Delivery friction
Delivery and project teams are interrupted multiple times per week to assist with user support requests that depend on their system access. Each interruption breaks focus on in-progress work. Over a year, this represents hundreds of hours of lost delivery capacity.

### 3. Risk and inconsistency
Without a single view and a single action layer, changes made in one system are not automatically visible in others. Accounts may exist in Active Directory but not in netForum, or vice versa. Guest accounts go stale. Group memberships drift. The longer the gap between a cross-system review and its resolution, the greater the risk of access inconsistency.

---

## Who Feels This

| Role | Pain |
|---|---|
| **IT Service Desk analyst** | Cannot resolve most user requests without escalating to 2–3 other teams |
| **Active Directory / M365 administrator** | Repeatedly pulled in for requests that don't require deep expertise — just access |
| **netForum administrator** | Same — fielding handoffs for provisioning, updates, and lookups |
| **Delivery team member** | Interrupted multiple times per week to assist support; context lost each time |
| **Management** | No visibility into the aggregate cost; no SLA on cross-system resolution; accountability is diffuse |

---

## What a Resolution Looks Like

The problem is solved when a **first-line support analyst** can:

1. Find any user across all six systems in a single search
2. See their complete status — accounts, memberships, permissions, recent changes — without asking another team
3. Take action directly — provision an account, reset MFA, add to a group, revoke stale access — without routing to a specialist
4. Have every write action automatically ticketed and auditable

This does not require replacing any existing system. It requires a consolidation layer that sits across them.

---

*See [executive-overview.md](../executive-overview.md) for the proposed solution and [aws-migration-plan.md](../next-steps/aws-migration-plan.md) for the production deployment plan.*
