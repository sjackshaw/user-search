import json, random, re
from datetime import datetime, timedelta

random.seed(42)

first_names = [
    "James","Mary","John","Patricia","Robert","Jennifer","Michael","Linda","William","Barbara",
    "David","Elizabeth","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Charles","Karen",
    "Christopher","Lisa","Daniel","Nancy","Matthew","Betty","Anthony","Margaret","Mark","Sandra",
    "Donald","Ashley","Steven","Dorothy","Paul","Kimberly","Andrew","Emily","Joshua","Donna",
    "Kenneth","Michelle","Kevin","Carol","Brian","Amanda","George","Melissa","Timothy","Deborah",
    "Ronald","Stephanie","Edward","Rebecca","Jason","Sharon","Jeffrey","Laura","Ryan","Cynthia",
    "Jacob","Kathleen","Gary","Amy","Nicholas","Angela","Eric","Shirley","Jonathan","Anna",
    "Stephen","Brenda","Larry","Pamela","Justin","Emma","Scott","Nicole","Brandon","Helen",
    "Benjamin","Samantha","Samuel","Katherine","Raymond","Christine","Gregory","Debra","Frank","Rachel",
    "Alexander","Carolyn","Patrick","Janet","Jack","Maria","Dennis","Heather","Jerry","Ann",
    "Aisha","Omar","Priya","Raj","Yuki","Kenji","Fatima","Ibrahim","Lena","Dmitri",
    "Sofia","Mateo","Isabela","Diego","Amara","Kwame","Nadia","Tariq","Elena","Viktor",
    "Mei","Wei","Hana","Taro","Zara","Kofi","Nia","Javier","Camila","Sebastian",
    "Aaliya","Hamid","Layla","Karim","Nour","Yusuf","Sana","Amir","Danya","Rami"
]

last_names = [
    "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez",
    "Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin",
    "Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson",
    "Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores",
    "Green","Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell","Carter","Roberts",
    "Dubois","Muller","Garcia","Hassan","Park","Fernandez","Okafor","Tanaka","Rossi","Sharma",
    "Patel","Kumar","Singh","Nakamura","Yamamoto","Kovac","Novak","Petrov","Ivanov","Schmidt",
    "Weber","Wagner","Fischer","Meyer","Becker","Hoffmann","Schulz","Koch","Richter","Klein",
    "Wolf","Schroeder","Neumann","Schwarz","Zimmermann","Braun","Kruger","Hartmann","Lange","Schmitt",
    "Werner","Schmitz","Krause","Meier","Lehmann","Huber","Mayer","Herrmann","Konig","Walter",
    "Mensah","Owusu","Asante","Boateng","Diallo","Traore","Coulibaly","Toure","Keita","Cisse",
    "Watanabe","Suzuki","Sato","Kobayashi","Ito","Koga","Hayashi","Kimura","Saito","Kato",
    "Ali","Ahmed","Mohammed","Abdullah","Rahman","Khan","Malik","Sheikh","Chaudhry","Qureshi",
    "OBrien","Murphy","Kelly","Ryan","Sullivan","Walsh","OConnor","McCarthy","Doyle","Brennan"
]

group_names = [
    "Engineering All","Product Team","Leadership","QA Guild","DevOps","Data Science","Security",
    "Marketing","Sales East","Sales West","Finance","Legal","HR","Operations","Infrastructure",
    "Frontend","Backend","Mobile","Design","Analytics","Customer Success","Support Tier 1",
    "Support Tier 2","Executive","Board Members","Research","Compliance","Audit","Recruiting",
    "IT Helpdesk","Cloud Platform","Database Admin","Network Ops","Application Security","Identity",
    "Architecture","API Platform","Integration","Automation","Machine Learning","AI Research",
    "Business Intelligence","Reporting","Growth","Partnerships","Vendor Management","Procurement",
    "Facilities","Events","Communications","Public Relations","Content","Social Media",
    "Community","Developer Relations","Documentation","Training","Onboarding","Offboarding",
    "Alumni","Contractors","Interns","Fellows","Advisory","Stakeholders","Investors",
    "Global East","Global West","EMEA","APAC","LATAM","North America","Europe","Asia Pacific",
    "Product Alpha","Product Beta","Product Gamma","Product Delta","Product Epsilon",
    "Squad Phoenix","Squad Atlas","Squad Titan","Squad Nova","Squad Orion","Squad Apex",
    "Tiger Team","Skunkworks","Innovation Lab","Platform Guild","SRE Team","Release Eng",
    "Customer Insights","Brand","Demand Gen","Field Sales","Inside Sales","Channel Partners",
    "Revenue Ops","Deal Desk","Solutions Eng","Professional Services","Implementation",
    "Renewals","Expansion","Onboarding Ops","Escalations","Trust and Safety","Accessibility",
    "Localization","Privacy","Risk","Ethics","Sustainability","Diversity Equity Inclusion",
    "Talent Acquisition","Learning and Development","Total Rewards","People Analytics",
    "Workplace Exp","Corporate IT","Endpoint Mgmt","Enterprise Apps","Data Platform",
    "Observability","Chaos Eng","Performance Eng","Capacity Planning","Cost Optimization",
    "Zero Trust","Threat Intel","Red Team","Blue Team","GRC","SOC","CISO Office",
    "Product Strategy","Competitive Intel","Market Research","User Research","UX Writing",
    "Accessibility Engineering","Design Systems","Prototyping","Motion Design","Brand Design",
    "Sales Enablement","Partner Success","Alliance Mgmt","OEM","ISV","System Integrators",
    "NA East Sales","NA West Sales","EMEA Sales","APAC Sales","LATAM Sales","Federal Sales",
    "Enterprise Accounts","Mid-Market","SMB","Commercial","Public Sector","Financial Services",
    "Healthcare","Retail","Manufacturing","Education","Media","Telco","Energy","Government"
]

used_emails = set()

def make_email(first, last, domain):
    clean_first = re.sub(r"[^a-z]", "", first.lower())
    clean_last  = re.sub(r"[^a-z]", "", last.lower())
    base = f"{clean_first}.{clean_last}"
    email = f"{base}@{domain}"
    n = 1
    while email in used_emails:
        email = f"{base}{n}@{domain}"
        n += 1
    used_emails.add(email)
    return email

def make_person(domain, type_val):
    first = random.choice(first_names)
    last  = random.choice(last_names)
    email = make_email(first, last, domain)
    return {"first_name": first, "last_name": last, "email": email, "type": type_val}

# ── Load AD data (used by netForum, external-user, and distribution-group) ────
ad_data = json.load(open("services/etl-ad-line/data/primary.json"))
ad_users = [p for p in ad_data if p.get("type") == "user"]

login_start = datetime(2024, 1, 1)
login_end   = datetime(2026, 2, 20)

def random_datetime():
    delta = login_end - login_start
    rand_seconds = random.random() * delta.total_seconds()
    return (login_start + timedelta(seconds=rand_seconds)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

# ── netForum: 1000 members (25% from AD users and contacts) ──────────────────
ad_nf_count = 250
gen_nf_count = 750

netforum = []

# 25% from AD (both users and contacts)
ad_nf_sample = random.sample(ad_data, ad_nf_count)
for p in ad_nf_sample:
    netforum.append({
        "first_name": p["first_name"],
        "last_name": p["last_name"],
        "email": p["email"],
        "type": "member",
        "lastLogin": random_datetime(),
        "enabled": random.random() > 0.1,
    })

# 75% freshly generated
for _ in range(gen_nf_count):
    person = make_person("members.org", "member")
    person["lastLogin"] = random_datetime()
    person["enabled"] = random.random() > 0.1
    netforum.append(person)

random.shuffle(netforum)
with open("services/etl-netforum-line/data/primary.json", "w") as f:
    json.dump(netforum, f, indent=2, ensure_ascii=True)
print(f"netForum: {len(netforum)} records written ({ad_nf_count} from AD, {gen_nf_count} generated)")

# ── external-user: 1000 external users (10% from AD contacts) ────────────────
# 10% of external users come from AD contacts
ad_contact_count = 100
ext_generated_count = 900

external = []

# Pick AD contacts for the first 10%
ad_sample = random.sample(ad_data, ad_contact_count)
for p in ad_sample:
    sponsor = random.choice(ad_users)
    sponsor_name = f"{sponsor['first_name']} {sponsor['last_name']}"
    external.append({
        "first_name": p["first_name"],
        "last_name": p["last_name"],
        "email": p["email"],
        "type": "external-user",
        "enabled": random.random() > 0.1,
        "sponsor": sponsor_name,
    })

# Remaining 90% are freshly generated external users
for _ in range(ext_generated_count):
    person = make_person("external.com", "external-user")
    sponsor = random.choice(ad_users)
    sponsor_name = f"{sponsor['first_name']} {sponsor['last_name']}"
    person["enabled"] = random.random() > 0.1
    person["sponsor"] = sponsor_name
    external.append(person)

random.shuffle(external)
with open("services/etl-eu-line/data/primary.json", "w") as f:
    json.dump(external, f, indent=2, ensure_ascii=True)
print(f"external-user: {len(external)} records written ({ad_contact_count} from AD, {ext_generated_count} generated)")

# ── distribution-group: 500 groups with AD contacts ───────────────────────────
ad_contacts = [
    {"first_name": p["first_name"], "last_name": p["last_name"], "email": p["email"]}
    for p in ad_data
]

used_aliases = set()
groups = []
name_pool = group_names[:]
# pad with generated names if we need more than 120
suffixes = ["Alpha","Beta","Gamma","Delta","Epsilon","Zeta","Eta","Theta","Iota","Kappa"]
for s in suffixes:
    for t in ["Team","Group","Squad","Guild"]:
        name_pool.append(f"{t} {s}")

random.shuffle(name_pool)

def make_alias(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

for i in range(500):
    name = name_pool[i] if i < len(name_pool) else f"Group {i+1}"
    alias = make_alias(name)
    base_alias = alias
    n = 1
    while alias in used_aliases:
        alias = f"{base_alias}-{n}"
        n += 1
    used_aliases.add(alias)
    email = f"{alias}@lists.corporate.com"
    size = random.randint(3, 12)
    contacts = random.sample(ad_contacts, size)
    groups.append({"name": name, "alias": alias, "email": email, "contacts": contacts})

with open("services/etl-dg-line/data/primary.json", "w") as f:
    json.dump(groups, f, indent=2, ensure_ascii=True)
print(f"distribution-group: {len(groups)} groups written")

# ── Activity log helpers ───────────────────────────────────────────────────────
ad_user_full_names = [f"{u['first_name']} {u['last_name']}" for u in ad_users]

def pick_ad_users(n):
    """Return up to n unique AD user full names."""
    return random.sample(ad_user_full_names, min(n, len(ad_user_full_names)))

# ── active-directory-activity-logs: 500 records ───────────────────────────────
ad_action_templates = [
    lambda refs: f"Account disabled following HR offboarding request. Reviewed by {refs[0]}.",
    lambda refs: f"Account enabled after manager approval. Confirmed by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Account enabled after manager approval. Confirmed by {refs[0]}.",
    lambda refs: f"Password reset initiated by helpdesk. Notified: {', '.join(refs[:3])}.",
    lambda refs: f"Account locked due to failed login attempts. Escalated to {refs[0]} for review.",
    lambda refs: f"Account type changed from contact to user. Approved by {refs[0]}.",
    lambda refs: f"Security audit: account reviewed by {refs[0]}. No anomalies found.",
    lambda refs: f"Account re-enabled following leave of absence. HR confirmation from {refs[0]}.",
    lambda refs: f"Bulk provisioning: {len(refs)} accounts updated. Coordinated by {refs[0]}.",
    lambda refs: f"Account suspended pending investigation. Action authorised by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Account suspended pending investigation. Action authorised by {refs[0]}.",
    lambda refs: f"Directory sync: account attributes refreshed. Verified by {refs[0]}.",
    lambda refs: f"Group membership changes reflected in account flags. Approved by {refs[0]}.",
    lambda refs: f"Offboarding checklist completed. Account archived by {refs[0]}.",
    lambda refs: f"New starter provisioning complete. Onboarding liaison: {refs[0]}.",
    lambda refs: f"Account unlocked after security clearance granted. Authorised by {refs[0]} ({refs[1]})." if len(refs) > 1 else f"Account unlocked after security clearance granted. Authorised by {refs[0]}.",
    lambda refs: f"Quarterly access review: account retained. Signed off by {', '.join(refs[:4])}.",
    lambda refs: f"MFA enrollment completed for account. Verified by {refs[0]}.",
    lambda refs: f"Account moved to new OU following department restructure. Approved by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Account moved to new OU following department restructure. Approved by {refs[0]}.",
    lambda refs: f"Privileged access granted for project duration. Time-limited approval by {refs[0]}.",
    lambda refs: f"Stale account detected during audit cycle. Disabled by {refs[0]} pending owner confirmation.",
    lambda refs: f"Password expiry policy updated for account. Change logged by {refs[0]}.",
    lambda refs: f"Role-based access control updated. Account assigned to new security group. Approved by {refs[0]}.",
    lambda refs: f"Account credential breach suspected. Emergency lockout initiated by {refs[0]}. Incident ticket raised.",
    lambda refs: f"Service account converted to user account. Migration verified by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Service account converted to user account. Migration verified by {refs[0]}.",
    lambda refs: f"Compliance review completed. Account access aligns with least-privilege policy. Signed off by {', '.join(refs[:3])}.",
    lambda refs: f"Account display name updated following legal name change. Processed by {refs[0]}.",
]

ad_activity_logs = []
for _ in range(3000):
    subject = random.choice(ad_data)
    changer = random.choice(ad_users)
    refs = pick_ad_users(random.randint(1, 10))
    template = random.choice(ad_action_templates)
    ad_activity_logs.append({
        "timestamp": random_datetime(),
        "first_name": subject["first_name"],
        "last_name": subject["last_name"],
        "email": subject["email"],
        "changed_by": f"{changer['first_name']} {changer['last_name']}",
        "notes": template(refs),
    })

# ── external-user-activity-logs: 2000 records ─────────────────────────────────
ext_data = json.load(open("services/etl-eu-line/data/primary.json"))

ext_action_templates = [
    lambda refs: f"External account created. Sponsored by {refs[0]}. Access provisioned per policy.",
    lambda refs: f"External account disabled after contract expiry. Reviewed by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"External account disabled after contract expiry. Reviewed by {refs[0]}.",
    lambda refs: f"Sponsor reassigned from {refs[0]} to {refs[1]}." if len(refs) > 1 else f"Sponsor updated. Reviewed by {refs[0]}.",
    lambda refs: f"Access extended by 90 days. Approved by {refs[0]}.",
    lambda refs: f"External user onboarded to partner portal. Coordinated by {refs[0]}.",
    lambda refs: f"Annual review completed. Account retained with approval from {', '.join(refs[:3])}.",
    lambda refs: f"Account suspended due to inactivity. Flagged by {refs[0]}.",
    lambda refs: f"Password reset requested by sponsor {refs[0]}. Processed by helpdesk.",
    lambda refs: f"External user permissions scoped down following security review. Sign-off: {refs[0]}.",
    lambda refs: f"Vendor access revoked upon project completion. Confirmed by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Vendor access revoked upon project completion. Confirmed by {refs[0]}.",
    lambda refs: f"Onboarding checklist completed. IT liaison: {refs[0]}.",
    lambda refs: f"Two-factor authentication enrolled. Verified by {refs[0]}.",
    lambda refs: f"Access request approved by {refs[0]} following manager recommendation.",
    lambda refs: f"External account re-enabled after background check clearance. Authorised by {refs[0]}.",
    lambda refs: f"Quarterly external user audit: account reviewed by {', '.join(refs[:4])}.",
    lambda refs: f"Contract renewal triggered automatic access review. Sign-off obtained from {refs[0]}.",
    lambda refs: f"External account flagged by DLP policy. Access reviewed and scoped by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"External account flagged by DLP policy. Access reviewed by {refs[0]}.",
    lambda refs: f"Partner organisation offboarding: all associated accounts disabled. Coordinated by {refs[0]}.",
    lambda refs: f"External user linked to internal project. Access granted with time boundary. Approved by {refs[0]}.",
    lambda refs: f"Compliance audit: external account verified against vendor contract. Signed off by {', '.join(refs[:3])}.",
    lambda refs: f"Account access tier downgraded following reduced engagement. Actioned by {refs[0]}.",
    lambda refs: f"Security incident response: external account credentials rotated. Managed by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Security incident response: external account credentials rotated. Managed by {refs[0]}.",
    lambda refs: f"Onboarding delayed due to incomplete documentation. Status updated by {refs[0]}.",
    lambda refs: f"Data residency requirements applied to account. Policy enforced by {refs[0]}.",
    lambda refs: f"External user NDA expiry prompted access suspension. Processed by {refs[0]}.",
]

ext_activity_logs = []
for _ in range(2000):
    subject = random.choice(ext_data)
    changer = random.choice(ad_users)
    refs = pick_ad_users(random.randint(1, 10))
    template = random.choice(ext_action_templates)
    ext_activity_logs.append({
        "timestamp": random_datetime(),
        "first_name": subject["first_name"],
        "last_name": subject["last_name"],
        "email": subject["email"],
        "changed_by": f"{changer['first_name']} {changer['last_name']}",
        "notes": template(refs),
    })

# ── netforum-activity-logs: 2000 records ──────────────────────────────────────
nf_data = json.load(open("services/etl-netforum-line/data/primary.json"))

nf_action_templates = [
    lambda refs: f"Membership renewed for the current fiscal year. Processed by {refs[0]}.",
    lambda refs: f"Member account created following application approval. Reviewed by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Member account created following application approval. Reviewed by {refs[0]}.",
    lambda refs: f"Membership lapsed; account suspended. Notified by {refs[0]}.",
    lambda refs: f"Member details updated following name change. Verified by {refs[0]}.",
    lambda refs: f"Membership category upgraded to Fellow. Approved by {', '.join(refs[:3])}.",
    lambda refs: f"Account disabled at member request. Processed by {refs[0]}.",
    lambda refs: f"Duplicate account merged. Records consolidated by {refs[0]}.",
    lambda refs: f"Member re-instated after payment received. Confirmed by {refs[0]}.",
    lambda refs: f"Annual conference access granted. Coordinated by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Annual conference access granted. Coordinated by {refs[0]}.",
    lambda refs: f"Email preferences updated per GDPR request. Action logged by {refs[0]}.",
    lambda refs: f"Membership transferred to new chapter. Approved by {refs[0]}.",
    lambda refs: f"Account password reset following security alert. Monitored by {refs[0]}.",
    lambda refs: f"Member profile privacy settings changed. Reviewed by {refs[0]}.",
    lambda refs: f"Bulk membership renewal processed. Administered by {refs[0]} with sign-off from {refs[1]}." if len(refs) > 1 else f"Bulk membership renewal processed. Administered by {refs[0]}.",
    lambda refs: f"Board election eligibility confirmed. Validated by {', '.join(refs[:4])}.",
    lambda refs: f"Continuing education credits applied to member record. Logged by {refs[0]}.",
    lambda refs: f"Member requested data export under GDPR Article 20. Processed by {refs[0]}.",
    lambda refs: f"Membership on hold pending disciplinary review. Action authorised by {', '.join(refs[:3])}.",
    lambda refs: f"New member orientation completed. Onboarding tracked by {refs[0]}.",
    lambda refs: f"Member fee waiver applied following hardship application. Approved by {refs[0]} and {refs[1]}." if len(refs) > 1 else f"Member fee waiver applied following hardship application. Approved by {refs[0]}.",
    lambda refs: f"Emergency contact details updated at member request. Verified by {refs[0]}.",
    lambda refs: f"Membership auto-renewal failed due to payment issue. Alerted by system; reviewed by {refs[0]}.",
    lambda refs: f"Member organisation affiliation updated. Cross-checked by {refs[0]}.",
    lambda refs: f"Access to restricted member resources granted following committee vote. Logged by {refs[0]}.",
    lambda refs: f"Annual survey response linked to member profile. Administered by {refs[0]}.",
]

nf_activity_logs = []
for _ in range(2000):
    subject = random.choice(nf_data)
    changer = random.choice(ad_users)
    refs = pick_ad_users(random.randint(1, 10))
    template = random.choice(nf_action_templates)
    nf_activity_logs.append({
        "timestamp": random_datetime(),
        "first_name": subject["first_name"],
        "last_name": subject["last_name"],
        "email": subject["email"],
        "changed_by": f"{changer['first_name']} {changer['last_name']}",
        "notes": template(refs),
    })

# ── distribution-group-sync-logs: 1500 records ────────────────────────────────
dg_data = json.load(open("services/etl-dg-line/data/primary.json"))

dg_sync_templates = [
    lambda added, removed, actor: f"Onboarding sync: {actor} added new starters following HR sign-off. Verified against AD provisioning.",
    lambda added, removed, actor: f"Compliance review: membership realigned per audit findings. Action taken by {actor} (Systems Administrator).",
    lambda added, removed, actor: f"URGENT: Upcoming mail campaign requires updated recipient list. Requested by {actor} (IT Manager).",
    lambda added, removed, actor: f"Offboarding batch: {len(removed)} account(s) removed following confirmed departures. Processed by {actor}.",
    lambda added, removed, actor: f"Quarterly group review: {len(added)} added, {len(removed)} removed. Signed off by {actor}.",
    lambda added, removed, actor: f"Project team reshuffle: distribution list updated to reflect new assignments. Coordinated by {actor}.",
    lambda added, removed, actor: f"Annual membership audit: stale records removed and active members re-confirmed. Authorised by {actor}.",
    lambda added, removed, actor: f"Emergency update following security incident: suspect accounts removed. Escalated by {actor}.",
    lambda added, removed, actor: f"New department formed: recipients added to shared DL. Provisioned by {actor} per org chart change.",
    lambda added, removed, actor: f"Post-acquisition sync: external partner accounts integrated into distribution group. Managed by {actor}.",
    lambda added, removed, actor: f"Scheduled automation run: group synchronised with directory source of truth. Verified by {actor}.",
    lambda added, removed, actor: f"Contractor offboarding: all temporary accounts removed from group. Cleared by {actor}.",
    lambda added, removed, actor: f"Role-based policy update: group scope narrowed to align with least-privilege principle. Actioned by {actor}.",
    lambda added, removed, actor: f"Leadership change: outgoing executives removed, incoming executives added. Transition managed by {actor}.",
    lambda added, removed, actor: f"Merger integration sync: {len(added)} accounts merged from legacy system. Reviewed by {actor}.",
    lambda added, removed, actor: f"IT helpdesk escalation: user self-reported missing from group. Corrected by {actor} after validation.",
    lambda added, removed, actor: f"Data governance review: accounts without valid business justification removed. Signed off by {actor}.",
    lambda added, removed, actor: f"Pre-event sync: all registered attendees added to event DL. Issued by {actor}.",
    lambda added, removed, actor: f"Compliance mandate: GDPR opt-out applied, {len(removed)} account(s) removed from mailing group. Logged by {actor}.",
    lambda added, removed, actor: f"Group restructure following cost centre realignment. Updated by {actor} per finance directive.",
]

def make_account_list(n):
    return [
        {
            "first_name": u["first_name"],
            "last_name": u["last_name"],
            "email": u["email"],
        }
        for u in random.sample(ad_users, min(n, len(ad_users)))
    ]

dg_sync_logs = []
for _ in range(1500):
    group = random.choice(dg_data)
    actor_user = random.choice(ad_users)
    actor = f"{actor_user['first_name']} {actor_user['last_name']}"
    n_added = random.choices([0, 1, 2, 3, 4, 5], weights=[20, 30, 25, 12, 8, 5])[0]
    n_removed = random.choices([0, 1, 2, 3, 4, 5], weights=[20, 30, 25, 12, 8, 5])[0]
    added = make_account_list(n_added)
    removed = make_account_list(n_removed)
    template = random.choice(dg_sync_templates)
    dg_sync_logs.append({
        "sync_timestamp": random_datetime(),
        "group_name": group["name"],
        "accounts_added": added,
        "accounts_removed": removed,
        "notes": template(added, removed, actor),
    })

# ── Write logs data ───────────────────────────────────────────────────────────
with open("services/etl-ad-line/data/logs.json", "w") as f:
    json.dump(ad_activity_logs, f, indent=2, ensure_ascii=True)
print(f"etl-ad-line/data/logs.json written ({len(ad_activity_logs)} records)")

with open("services/etl-eu-line/data/logs.json", "w") as f:
    json.dump(ext_activity_logs, f, indent=2, ensure_ascii=True)
print(f"etl-eu-line/data/logs.json written ({len(ext_activity_logs)} records)")

with open("services/etl-netforum-line/data/logs.json", "w") as f:
    json.dump(nf_activity_logs, f, indent=2, ensure_ascii=True)
print(f"etl-netforum-line/data/logs.json written ({len(nf_activity_logs)} records)")

with open("services/etl-dg-line/data/logs.json", "w") as f:
    json.dump(dg_sync_logs, f, indent=2, ensure_ascii=True)
print(f"etl-dg-line/data/logs.json written ({len(dg_sync_logs)} records)")
