# Manual Test Script — Full Functionality Walkthrough

A step-by-step script for a **human tester** to click/type through every piece of
functionality in the app as it exists today. This is not an automated test —
check each box yourself and note anything that doesn't match the expected result.

---

## 0. Before you start

1. Start the full stack from the repo root:
   ```sh
   ./startup/setup.sh
   ```
   First run downloads the `qwen2.5:3b` Ollama model (a few minutes) and the SBERT
   embedding model — subsequent runs are fast.
2. Open **http://localhost:3000** in a browser. That's the only URL you need —
   the chat agent (genai, port 3001) is proxied through it.
3. The four dashboard panels at the top of the page (**Compliance Posture**,
   **Activity Trends**, **Reports**, **Policy Rules**) load automatically on
   page load. If any show "Could not load…", refresh once the stack has fully
   started. Each panel title (plus the Reports panel's "Violations" and
   "Change Logs" links) is clickable and opens a card-based drill-down view of
   the underlying data.
4. There is **no login** — the app is intentionally unauthenticated. Nothing to
   sign into.
5. To talk to the agent, there are two ways in:
   - Search for any person, click their result card to open the detail
     overlay, and use the chat box inside it — this is bound to that real
     user, so account-specific actions (disable, reset password, licenses,
     groups, MFA, onboarding, etc.) work here.
   - Click the floating **🤖** chat icon (bottom-right corner, visible on every
     page) for governance/policy questions that aren't about a specific
     person — e.g. *"set min_group_owners to 2"* or *"show open
     violations"*. This widget has **no real user loaded**, so the service
     refuses account-specific requests server-side and tells you to search
     for that person instead; governance/policy/reporting tools work fine
     from here.
   **Exact wording doesn't matter** — the LLM interprets intent — but a
   suggested phrase is given for each item below so you don't have to guess.
6. If the agent doesn't pick the tool you expect, try rephrasing once before
   assuming it's broken — `qwen2.5:3b` is a small local model and occasionally
   needs a clearer prompt.
7. To reset between test passes without losing synthetic data, just refresh the
   page — nothing here requires a clean database. To fully reset:
   `./startup/teardown.sh --destroy` then `./startup/setup.sh` again.

---

## A. Core Search & Lookup (no agent involved)

- [ ] **Plain semantic search** — Type a first name, last name, or email fragment
      in the main search box → results appear from across Active Directory,
      netForum, External Users, Distribution Groups, SharePoint Permissions, and
      M365 Group Memberships, each with a colored source badge.
- [ ] **Attribute filter** — Search `enabled:false` or `locked:true` → results
      narrow to matching accounts only.
- [ ] **Intersection query** — Search `users in active directory and netforum`
      → banner shows "Interpreted: Users in **Active Directory** AND
      **netForum**" and results are the overlap.
- [ ] **Exclusion query** — Search `in active directory and not in external
      users` → banner confirms the NOT clause; results exclude that source.
- [ ] **Open a detail card** — Click any result → overlay opens showing every
      field for that record (and other-source records for the same email, if
      any).
- [ ] **Change history** — In the detail card, scroll to **Change History** →
      shows create/update/delete entries with old→new value diffs (populated by
      each ETL line's change detection).
- [ ] *(Optional, API-level)* **ETL job status** — Visit
      `http://localhost:3000/api/etl-jobs` (send header `x-api-key:
      dev-key-please-change` if querying via curl/Postman) → JSON list of recent
      ETL runs per service with records processed/created/updated/deleted.

---

## B. Agent: Account Operations

Open any user's detail card for these.

- [ ] **provision_account** — Pick someone who only exists in one system (check
      which sources they're missing from in the card) → say *"Create an account
      for this person in Active Directory"* → ticket created and auto-closed,
      new record appears.
- [ ] **disable_account** — Say *"Disable this account, they left the
      company"* → account(s) show `enabled: false` afterward.
- [ ] **reset_password** — Say *"Reset their password"* → ticket auto-closes.
- [ ] **update_attribute** — Say *"Update their sponsor to jane.doe@corporate.com
      in external users"* (pick a field/system that applies) → value changes.
- [ ] **add_to_group** — Say *"Add them to the [any distribution group name]
      mailing list"* → confirmation + membership count increases.
- [ ] **add_to_m365_group** — Say *"Add them to the [any M365 group name] as a
      member"* (or *"...as an owner"*) → confirmation with role shown.

---

## C. Agent: Microsoft 365 Service Desk

All of these run in **mock Graph mode** by default (no `ENTRA_TENANT_ID` set) —
responses are synthetic/local, not live Entra data. That's expected.

- [ ] **reset_mfa** — *"Reset their MFA"* → confirms reset.
- [ ] **get_mfa_status** — *"Is MFA enabled for this user?"* → read-only status.
- [ ] **assign_license** — *"Assign an E3 license"* → confirms assignment.
- [ ] **remove_license** — *"Remove their E5 license"* → confirms removal.
- [ ] **grant_mailbox_access** — *"Give jane.doe@corporate.com read access to
      this mailbox"* → confirms.
- [ ] **add_email_alias** — *"Add the alias j.smith@corporate.com"* → confirms.
- [ ] **get_out_of_office** — *"Is their out-of-office on?"* → read-only.
- [ ] **set_out_of_office** — *"Set an out-of-office saying I'm on leave until
      Friday"* → confirms message set.
- [ ] **add_to_teams_channel** — *"Add them to Teams channel general in team
      Engineering"* → confirms.
- [ ] **grant_onedrive_access** — *"Give jane.doe@corporate.com write access to
      their OneDrive"* → confirms.

---

## D. Agent: Lifecycle Management

- [ ] **onboard_user** — *"Onboard a new hire: first name Alex, last name Rivera,
      email alex.rivera@corporate.com, department marketing"* → one action
      provisions accounts, assigns the license, and adds department groups. Use
      **list_access_templates** first (below) if unsure of valid department
      keys.
- [ ] **offboard_user** — On an existing user: *"Offboard this person, they
      resigned"* → disables all accounts, strips groups/SharePoint, reclaims
      licenses, sets out-of-office — in one go.
- [ ] **deprovision_cascade** — On an already-disabled user: *"Clean up their
      remaining access"* → removes groups/SharePoint/licenses without
      re-disabling the account.

---

## E. Agent: Bulk Operations

- [ ] **bulk_action** — *"Disable these accounts: a@x.com, b@x.com, c@x.com"*
      (use three real emails from search results) → one ticket-style response
      covering all three; verify each was actually disabled.

---

## F. Agent: Access Requests & Department Templates

- [ ] **list_access_templates** — *"What department templates are available?"*
      → lists department keys with their license + group bundles.
- [ ] **apply_access_template** — *"Apply the finance department template to
      this user"* (use a key from the previous step) → assigns that
      department's standard license + groups in one action.
- [ ] **submit_access_request** — *"Request access to the [any distribution
      group] mailing list, reason: need it for my role"* → request logged as
      **pending**, nothing granted yet.
- [ ] **list_access_requests** — *"Show pending access requests"* → your
      request appears.
- [ ] **approve_access_request** — *"Approve request #<id>"* (use the ID from
      the previous step) → status flips to approved and the access is granted
      immediately.

---

## G. Agent: Governance Detection

These work immediately on existing synthetic data — no setup needed.

- [ ] **list_inactive_licenses** — *"Show unused E3 licenses"* → list of users
      whose `last_sign_in_at`/`passwordlastreset` exceeds 90 days, with
      estimated monthly savings.
- [ ] **list_stale_guests** — *"Show stale guest accounts"* → list of
      inactive external/guest users.
- [ ] **list_naming_violations** — *"Which groups break our naming
      convention?"* → most synthetic groups will show up (they're named
      "Group 123" etc., not `DL-`/`SG-`/`M365-` prefixed) — this is expected,
      not a bug.
- [ ] **enforce_naming_convention** — *"Fix all the group naming violations"*
      → bulk-renames them; re-running **list_naming_violations** afterward
      should show zero (or far fewer) violations.
- [ ] **list_groups_missing_owners** — *"Which M365 groups don't have enough
      owners?"* → list with current vs. required owner count.
- [ ] **enforce_minimum_owners** — *"Fix the groups missing owners"* → promotes
      the earliest-joined member in each to owner.
- [ ] **list_orphaned_resources** — *"Which groups or SharePoint sites have no
      owner at all?"* → list, each with a `suggestedOwner`.
- [ ] **reassign_resource_owner** — *"Reassign the owner for [a group/site name
      from the previous step]"* (omit the new owner's email to let it
      auto-pick the suggestion) → confirms new owner.
- [ ] **list_oversharing_risks** — *"Show SharePoint oversharing risks"* →
      should return a handful of `broad_share_scope` results (seeded literal
      "Everyone"/anonymous-link grants) plus `external_elevated_access` results
      (external users with Edit/FullControl).

---

## H. Agent: M365 Governance Actions

- [ ] **revoke_guest_access** — On a stale guest from §G: *"Revoke this guest's
      access"* → ticket auto-closes, account disabled.
- [ ] **dismiss_risky_user** — *"Dismiss the risky-user flag for this account,
      it was a false positive"* → confirms dismissal.
- [ ] **list_app_consents** — *"What OAuth apps has this user consented to?"*
      → read-only list (empty/stub in mock mode — expected).
- [ ] **revoke_app_consent** — *"Revoke consent ID xyz for this user"* →
      confirms (mock mode).
- [ ] **explain_ca_block** — *"Why might this user be blocked by Conditional
      Access?"* → read-only explanation.
- [ ] **get_device_compliance** — *"Is their device compliant?"* → read-only
      (mock mode).
- [ ] **get_bitlocker_key** — *"Get the BitLocker recovery key for their
      device"* → returns a key with a full ticket audit trail.

---

## I. Agent: Violation Tracking & Automated Remediation (§3c)

- [ ] **scan_governance_violations** — *"Run a full governance scan"* →
      summary counts by severity; this also runs automatically once at genai
      startup and daily via cron, so proposals may already exist.
- [ ] **list_violations** — *"Show open violations"* → itemized list with
      severity, assignee, and age in days.
- [ ] **list_violations (remediation filter)** — *"Show violations with a
      pending remediation proposal"* → should return naming/ownership issues
      already auto-proposed by the scan (status `proposed`).
- [ ] **assign_violation** — *"Assign violation #<id> to jane.doe@corporate.com"*
      → status moves to `acknowledged`.
- [ ] **approve_remediation** — *"Approve the remediation for violation #<id>"*
      (pick one with a pending proposal) → the fix is **applied immediately**
      (group renamed / owner promoted or reassigned) and the violation resolves.
      Confirm the underlying group actually changed.
- [ ] **reject_remediation** — *"Reject the remediation for violation #<id>"*
      → proposal marked rejected, violation stays open, **nothing is changed**.
- [ ] **resolve_violation** — *"Mark violation #<id> as resolved, we fixed it
      manually"* → status becomes resolved.
- [ ] **Dashboard check** — Reload the page → **Compliance Posture** panel shows
      a "⏳ N awaiting approval" banner whenever `proposed` remediations exist.
- [ ] *(Advanced/optional, requires psql)* **Event-driven trigger** — Connect to
      Postgres (`docker compose -f docker-compose.postgres.yml exec postgres
      psql -U postgres -d appdb`) and update any `m365_group_memberships` row's
      `group_name` to something without a valid prefix, then immediately query
      `governance_violations` — a `naming_convention` row appears instantly,
      with `remediation_status = 'proposed'`, with **no chat message and no
      cron run involved**. This proves detection is genuinely event-driven, not
      just scheduled.

---

## J. Dashboard Panels & Reporting (§3d)

- [ ] **Compliance Posture panel** — Shows a 0–100 score (colour-coded),
      severity breakdown badges, and violation-type counts as a card grid with
      title-cased labels. Click **Rescan** → numbers refresh. Click the panel
      title → drill-down overlay lists every open violation with full detail
      (resource, age, assignee, remediation status).
- [ ] **get_compliance_score** (via chat) — *"What's our compliance score?"* →
      same numbers as the dashboard panel.
- [ ] **Activity Trends panel** — Three stacked mini bar-charts (source data
      changes, ETL job outcomes, violations) over the last 14 days. Click the
      panel title → drill-down overlay shows the raw daily counts as tables.
- [ ] **get_trend_analytics** (via chat) — *"Show me trends over the last 30
      days"* → same shape of data, configurable window.
- [ ] **Reports panel — download buttons** — Click **Download Violations CSV**
      and **Download Change Logs CSV** → files download with real rows.
- [ ] **Reports panel — Violations / Change Logs links** — Click the
      **Violations** or **Change Logs** label (not the CSV button) → opens a
      card-based drill-down of that exact dataset, with a label stating what's
      shown and how many rows — distinct from the Compliance Posture violation
      view (that one is open-only; this one is all statuses).
- [ ] **Reports panel — history** — Shows prior snapshots as cards with row
      counts, generator, timestamp, and a **Download** button per row
      (populated by the daily report cron + any manual generations). Click the
      **Reports** panel title → drill-down overlay shows the full history (not
      just the latest 10).
- [ ] **generate_report** (via chat) — *"Generate a violations report"* →
      returns a report ID + download URL; appears in the Reports panel history
      on next refresh.
- [ ] **list_reports** (via chat) — *"What reports have been generated?"* →
      same list as the panel.
- [ ] **Policy Rules panel** — Read-only list grouped by friendly category
      headers (Naming Prefixes, Ownership Requirements, Violation Severity,
      Compliance Scoring Weights, Inactivity Thresholds, Governance Checks),
      each rule showing a business-readable description (not the internal key)
      and a human-friendly value (Enabled/Disabled, title-cased severities,
      "N days"); rules with a purple "override" badge have been changed from
      default.
- [ ] **list_policy_rules** (via chat) — *"What are the current governance
      policy rules?"* → same data as the panel.
- [ ] **set_policy_rule** (via chat, floating 🤖 icon or user card) — *"Set
      min_group_owners to 2"* → confirms; reload the Policy Rules panel → shows
      an "override" badge on that rule, and both panels refresh automatically
      right after the agent replies (no manual reload needed). Re-run
      **list_groups_missing_owners** (§G) → results should change to reflect
      the new threshold.
- [ ] **reset_policy_rule** (via chat) — *"Reset min_group_owners back to
      default"* → override badge disappears; behaviour reverts.
- [ ] **Floating agent scope guard** — Open the floating 🤖 icon (don't open a
      user card first) and ask it to *"disable the account for
      <any real email from search results>"* → agent declines / redirects you
      to search for that person instead of attempting the action; confirm via
      search that the account's `enabled` status is unchanged.

---

## K. Tickets & Misc

- [ ] **create_ticket** (fallback) — Ask for something off-menu, e.g. *"Can you
      order me a new laptop?"* → falls back to a general ticket instead of
      failing.
- [ ] **list_open_tickets** — *"What tickets are open for this user?"* → also
      visible directly in the detail card's **Open Tickets** section, with a
      **Close** button per ticket.
- [ ] **describe_capabilities** — *"What can you do?"* → agent lists all
      capability groups (account ops, lifecycle, bulk, access requests,
      templates, M365 service desk, governance & security, ticketing).

---

## Known out of scope (don't file these as bugs)

These are intentionally **not** implemented:

- No authentication/authorisation (anyone can do anything — documented, not a bug).
- No live Microsoft Graph data — everything governance-related runs in mock mode
  unless `ENTRA_TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` are configured.
- No PDF or email report delivery — CSV only.
- No templated Team/Site provisioning, no scheduled expiration/archival, no
  access-review/recertification workflow, no sensitivity-label awareness.
- Automated remediation only covers naming/ownership fixes — guest revocation,
  consent/license removal, etc. remain manual-only by design (too destructive to
  auto-propose).
