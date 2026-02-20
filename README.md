# TODO→ISSUE: GitHub → Jira Sync

Automatically syncs GitHub Issues (created by the TODO→ISSUE scanner) into Jira,
then closes the GitHub Issue as migrated with a link back to the Jira ticket.

## How it works

```
GitHub Issue opened/labeled
        │
        ▼
Does it have a `jira:PROJ-123` label?
        │
    YES ─────────────────► Skip (already synced)
        │
       NO
        │
        ▼
Create Jira issue
  - Summary from GH title (stripped of [TODO][P1] prefix)
  - Description with TODO text, file, line, author, commit, code context
  - Priority mapped from GH priority label
  - Issue type mapped from GH type label (bug/tech-debt/enhancement)
        │
        ▼
Add `jira:PROJ-123` label to GH issue   ← this is the sync key
        │
        ▼
Close GH issue with comment:
  "Migrated to Jira as PROJ-123 → <link>"
```

## Setup

### 1. Secrets (Settings → Secrets → Actions)

| Secret | Value |
|--------|-------|
| `JIRA_BASE_URL` | `https://yourorg.atlassian.net` |
| `JIRA_USER_EMAIL` | Email of the Jira account running the sync |
| `JIRA_API_TOKEN` | API token from https://id.atlassian.com/manage-profile/security/api-tokens |

### 2. Repository Variable (Settings → Variables → Actions)

| Variable | Value |
|----------|-------|
| `JIRA_PROJECT_KEY` | The Jira project key, e.g. `OLSF`, `PA`, `DED` |

This is a **variable** (not a secret) so it's visible and easy to change per-repo.
Different repos can sync to different Jira projects — just set different values.

### 3. Add the workflow

Copy `.github/workflows/jira-sync.yml` into your repo. That's it.

## Label format

The sync key label uses the format: **`jira:PROJ-123`**

- Presence of this label = issue has been synced to Jira
- The label name contains the exact Jira ticket number for traceability
- Labels are created automatically in the repo on first use

## Priority mapping

| GitHub label | Jira priority |
|---|---|
| `priority:critical` | Highest |
| `priority:high` | High |
| `priority:medium` | Medium |
| `priority:low` | Low |
| _(none)_ | Medium |

## Issue type mapping

| GitHub label | Jira type |
|---|---|
| `security`, `bug` | Bug |
| `tech-debt` | Task |
| `enhancement` | Story |
| _(none)_ | Task |

## Manual bulk sync

Trigger via **Actions → Sync GitHub Issues to Jira → Run workflow**.

Optional: enable **Dry run** to log what would happen without creating any Jira tickets.

This is useful for initial onboarding — it will scan all open issues, skip any
already labelled with `jira:*`, and sync the rest.

## Workflow triggers

- `issues.opened` — syncs immediately when a new issue is created
- `issues.reopened` — re-syncs if a closed issue is reopened without a Jira label
- `issues.labeled` — catches any manually created issues that get a priority label added
- `workflow_dispatch` — manual bulk sync with optional dry run
