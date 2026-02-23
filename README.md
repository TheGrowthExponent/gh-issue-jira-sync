# gh-issue-jira-sync

[![Test Status](https://github.com/TheGrowthExponent/gh-issue-jira-sync/actions/workflows/jira-sync.yml/badge.svg)](https://github.com/TheGrowthExponent/gh-issue-jira-sync/actions/workflows/jira-sync.yml)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/grexp)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?logo=paypal)](https://www.paypal.com/donate/?hosted_button_id=3D3EH5AXHUKEJ)
[![Donate via Stripe](https://img.shields.io/badge/Donate-Stripe-635bff.svg?logo=stripe&logoColor=white)](https://buy.stripe.com/5kQcN551M7ZM8LOa9c7EQ00)

> Automatically sync GitHub Issues to Jira — idempotent, zero-config, one file to add.

[![GitHub Action](https://img.shields.io/badge/GitHub_Action-reusable-blue?logo=github)](https://github.com/TheGrowthExponent/gh-issue-jira-sync)

---

## How it works

```
GitHub Issue opened
        │
        ▼
Has label  jira:PROJ-123 ?
  YES ──► Skip (already synced)
   NO
        │
        ▼
Create Jira issue
  · Summary  ← GH issue title (prefix stripped)
  · Priority ← mapped from priority:* label
  · Type     ← mapped from bug/tech-debt/enhancement label
  · Description ← full metadata: file, line, author, commit, code context
        │
        ▼
Add label  jira:PROJ-123  to GH issue   ← sync key
        │
        ▼
Close GH issue with comment + Jira link
```

The `jira:PROJ-123` label is the source of truth. If it's there, the issue is synced — no database, no external state.

---

## Quick start (2 minutes)

### 1. Add secrets to your repo

Settings → Secrets and variables → Actions → **Secrets**

| Secret            | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| `JIRA_BASE_URL`   | `https://yourorg.atlassian.net`                                                |
| `JIRA_USER_EMAIL` | Email of your Jira service account                                             |
| `JIRA_API_TOKEN`  | [Create one here](https://id.atlassian.com/manage-profile/security/api-tokens) |

### 2. Add a repo variable

Settings → Secrets and variables → Actions → **Variables**

| Variable           | Value                                            |
| ------------------ | ------------------------------------------------ |
| `JIRA_PROJECT_KEY` | Your Jira project key — e.g. `OLSF`, `PA`, `DED` |

This is a **variable** not a secret — easy to see and change per repo. Different repos can sync to different Jira projects.

### 3. Add the workflow file

Create `.github/workflows/jira-sync.yml` in your repo:

```yaml
name: Sync GitHub Issues to Jira

on:
  issues:
    types: [opened, reopened, labeled]
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run — log actions without creating Jira tickets'
        required: false
        default: 'false'
        type: boolean

jobs:
  sync-to-jira:
    uses: ./.github/workflows/sync.yml
    with:
      jira_project_key: ${{ vars.JIRA_PROJECT_KEY }}
      dry_run: ${{ github.event.inputs.dry_run || 'false' }}
      bulk_sync: ${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}
      close_after_sync: 'true'
      jira_issue_type_default: 'Task'
    secrets:
      jira_base_url: ${{ secrets.JIRA_BASE_URL }}
      jira_user_email: ${{ secrets.JIRA_USER_EMAIL }}
      jira_api_token: ${{ secrets.JIRA_API_TOKEN }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That's it. Next issue opened → Jira ticket created automatically.

---

## Label format

Issues get labelled `jira:PROJ-123` after syncing. This label:

- Is the idempotency key — if present, the issue is skipped
- Contains the exact Jira ticket number for traceability
- Is created automatically in your repo on first use (colour: blue)

---

## Priority mapping

| GitHub label        | Jira priority |
| ------------------- | ------------- |
| `priority:critical` | Highest       |
| `priority:high`     | High          |
| `priority:medium`   | Medium        |
| `priority:low`      | Low           |
| _(none)_            | Medium        |

## Issue type mapping

| GitHub label             | Jira type                                           |
| ------------------------ | --------------------------------------------------- |
| `security`, `bug`        | Bug                                                 |
| `tech-debt`              | Task                                                |
| `enhancement`, `feature` | Story                                               |
| _(none)_                 | Task _(configurable via `jira_issue_type_default`)_ |

---

## Inputs

| Input                     | Required | Default | Description                                             |
| ------------------------- | -------- | ------- | ------------------------------------------------------- |
| `jira_project_key`        | ✅       | —       | Jira project key (e.g. `OLSF`)                          |
| `dry_run`                 | ❌       | `false` | Log only — no Jira tickets, no closed issues            |
| `bulk_sync`               | ❌       | `false` | Sync all open unsynced issues (for `workflow_dispatch`) |
| `close_after_sync`        | ❌       | `true`  | Close the GH issue after creating the Jira ticket       |
| `jira_issue_type_default` | ❌       | `Task`  | Fallback Jira issue type when no type label matches     |

## Secrets

| Secret            | Required | Description                     |
| ----------------- | -------- | ------------------------------- |
| `jira_base_url`   | ✅       | `https://yourorg.atlassian.net` |
| `jira_user_email` | ✅       | Jira account email              |
| `jira_api_token`  | ✅       | Jira API token                  |
| `github_token`    | ✅       | Use `secrets.GITHUB_TOKEN`      |

---

## Outputs

| Output     | Description                                             |
| ---------- | ------------------------------------------------------- |
| `jira_key` | The Jira key created, e.g. `OLSF-42`. Empty if skipped. |

---

## Bulk migration

To sync all existing open issues on first setup:

1. Go to **Actions → Sync GitHub Issues to Jira → Run workflow**
2. Enable **Dry run** first — review what would be created
3. Run again without dry run to execute

Issues already labelled `jira:*` are always skipped.

---

## Works great with

This action pairs with [TODO→ISSUE](https://github.com/TheGrowthExponent/todo-issue) — which scans for
TODO comments on push and converts them to GitHub Issues automatically. Together:

```
git push → TODO scanned → GitHub Issue created → Jira ticket created → GH issue closed
```

Full lifecycle, zero manual steps.

---

## Contributing

PRs welcome. The sync logic lives in `scripts/sync.js` — it's intentionally a single
file with no build step. Add a mapping, fix a bug, open a PR.

## License

MIT
