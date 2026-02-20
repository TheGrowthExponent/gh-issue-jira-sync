/**
 * sync.js — GitHub Issue → Jira sync
 *
 * Logic:
 *   1. Fetch the GitHub issue (single issue or all open unsynced for bulk)
 *   2. Check labels for a `jira:PROJ-123` label → already synced, skip
 *   3. Map GH issue priority label (priority:critical etc.) to Jira priority
 *   4. Map GH issue type label (bug, tech-debt etc.) to Jira issue type
 *   5. Create Jira issue with full metadata in description
 *   6. Add `jira:PROJ-123` label to the GH issue (the sync key)
 *   7. Close GH issue with a comment linking to the Jira ticket
 */

import { Octokit } from '@octokit/rest';

// ─── Config ──────────────────────────────────────────────────────────────────

const {
  GITHUB_TOKEN,
  GH_REPO,
  GH_ISSUE_NUMBER,
  JIRA_BASE_URL,
  JIRA_USER_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  DRY_RUN,
  BULK_SYNC,
} = process.env;

const dryRun = DRY_RUN === 'true';
const bulkSync = BULK_SYNC === 'true';

// Validate required env
const required = { GITHUB_TOKEN, GH_REPO, JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY };
for (const [key, val] of Object.entries(required)) {
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
}

const [GH_OWNER, GH_REPO_NAME] = GH_REPO.split('/');

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Basic auth header for Jira REST API
const jiraAuth = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
const jiraHeaders = {
  'Authorization': `Basic ${jiraAuth}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

// ─── Priority mapping ─────────────────────────────────────────────────────────
// GH label → Jira priority name (must match your Jira priority scheme exactly)

const PRIORITY_MAP = {
  'priority:critical': 'Highest',
  'priority:high':     'High',
  'priority:medium':   'Medium',
  'priority:low':      'Low',
};

// ─── Issue type mapping ───────────────────────────────────────────────────────
// GH label → Jira issue type name

const TYPE_MAP = {
  'security':   'Bug',
  'bug':        'Bug',
  'tech-debt':  'Task',
  'enhancement':'Story',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract jira key from labels array if present.
 * Looks for a label matching `jira:PROJ-123` pattern.
 */
function getExistingJiraKey(labels) {
  const jiraLabel = labels.find(l => /^jira:[A-Z]+-\d+$/.test(l.name));
  return jiraLabel ? jiraLabel.name.replace('jira:', '') : null;
}

/**
 * Derive Jira priority from GH issue labels.
 * Falls back to 'Medium' if no priority label found.
 */
function derivePriority(labels) {
  for (const label of labels) {
    if (PRIORITY_MAP[label.name]) return PRIORITY_MAP[label.name];
  }
  return 'Medium';
}

/**
 * Derive Jira issue type from GH issue labels.
 * Falls back to 'Task'.
 */
function deriveIssueType(labels) {
  for (const label of labels) {
    if (TYPE_MAP[label.name]) return TYPE_MAP[label.name];
  }
  return 'Task';
}

/**
 * Parse the structured metadata block embedded in the GH issue body.
 * The TODO→ISSUE action writes a markdown table; we extract key fields.
 */
function parseIssueBody(body = '') {
  const extract = (field) => {
    const match = body.match(new RegExp(`\\|\\s*${field}\\s*\\|\\s*\`?([^\`|\\n]+)\`?\\s*\\|`));
    return match ? match[1].trim() : null;
  };

  return {
    file:      extract('File'),
    line:      extract('Line'),
    branch:    extract('Branch'),
    commit:    extract('Commit'),
    introduced: extract('Introduced'),
    author:    extract('Author'),
  };
}

/**
 * Build a Jira-formatted description (Atlassian Document Format).
 */
function buildJiraDescription(ghIssue, meta) {
  const ghUrl = ghIssue.html_url;
  const body = ghIssue.body || '';

  // Extract the TODO comment text from the GH issue body
  const todoMatch = body.match(/## TODO Comment\s*\n+>\s*(.+)/);
  const todoText = todoMatch ? todoMatch[1].trim() : ghIssue.title;

  // Extract code context block
  const codeMatch = body.match(/## Code Context\s*\n+(```[\s\S]*?```)/);
  const codeBlock = codeMatch ? codeMatch[1] : null;

  // ADF document
  const content = [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Migrated from GitHub Issues automatically by ', marks: [{ type: 'em' }] },
        { type: 'text', text: 'TODO→ISSUE', marks: [{ type: 'em' }, { type: 'strong' }] },
        { type: 'text', text: '.', marks: [{ type: 'em' }] },
      ],
    },
    {
      type: 'blockquote',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: todoText }],
      }],
    },
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Source Location' }],
    },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [
        tableRow(['Field', 'Value'], true),
        ...(meta.file      ? [tableRow(['File',       meta.file])]      : []),
        ...(meta.line      ? [tableRow(['Line',       meta.line])]      : []),
        ...(meta.branch    ? [tableRow(['Branch',     meta.branch])]    : []),
        ...(meta.commit    ? [tableRow(['Commit',     meta.commit])]    : []),
        ...(meta.introduced? [tableRow(['Introduced', meta.introduced])]: []),
        ...(meta.author    ? [tableRow(['Author',     meta.author])]    : []),
      ],
    },
  ];

  if (codeBlock) {
    const lang = (codeBlock.match(/```(\w+)/) || [])[1] || 'text';
    const code = codeBlock.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Code Context' }],
    });
    content.push({
      type: 'codeBlock',
      attrs: { language: lang },
      content: [{ type: 'text', text: code }],
    });
  }

  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'GitHub Issue' }],
  });
  content.push({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: ghUrl,
        marks: [{ type: 'link', attrs: { href: ghUrl } }],
      },
    ],
  });

  return { version: 1, type: 'doc', content };
}

function tableRow(cells, isHeader = false) {
  return {
    type: 'tableRow',
    content: cells.map(cell => ({
      type: isHeader ? 'tableHeader' : 'tableCell',
      attrs: {},
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: String(cell) }],
      }],
    })),
  };
}

// ─── Jira API calls ───────────────────────────────────────────────────────────

async function jiraRequest(method, path, body) {
  const url = `${JIRA_BASE_URL}/rest/api/3${path}`;
  const res = await fetch(url, {
    method,
    headers: jiraHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.status === 204 ? null : res.json();
}

async function createJiraIssue(ghIssue) {
  const labels = ghIssue.labels || [];
  const priority = derivePriority(labels);
  const issueType = deriveIssueType(labels);
  const meta = parseIssueBody(ghIssue.body);
  const description = buildJiraDescription(ghIssue, meta);

  // Strip the [TODO][P1] prefix from GH issue title for a clean Jira summary
  const summary = ghIssue.title
    .replace(/^\[TODO\]\[P\d[^\]]*\]\s*/, '')
    .replace(/^[^\]]*\]\s*/, '')
    .trim()
    .substring(0, 255); // Jira summary limit

  const payload = {
    fields: {
      project:     { key: JIRA_PROJECT_KEY },
      summary,
      description,
      issuetype:   { name: issueType },
      priority:    { name: priority },
      labels:      ['todo-issue', 'auto-migrated'],
    },
  };

  log(`Creating Jira issue in ${JIRA_PROJECT_KEY}: "${summary}" [${issueType}, ${priority}]`);

  if (dryRun) {
    log('[DRY RUN] Would create Jira issue with payload:', JSON.stringify(payload, null, 2));
    return 'DRY-RUN-123';
  }

  const result = await jiraRequest('POST', '/issue', payload);
  return result.key; // e.g. "OLSF-42"
}

// ─── GitHub operations ────────────────────────────────────────────────────────

async function addJiraLabel(issueNumber, jiraKey) {
  // Label format: jira:PROJ-123
  const labelName = `jira:${jiraKey}`;

  log(`Adding label "${labelName}" to GH issue #${issueNumber}`);

  if (dryRun) {
    log(`[DRY RUN] Would add label: ${labelName}`);
    return;
  }

  // Ensure the label exists in the repo (create if not)
  try {
    await octokit.issues.getLabel({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      name: labelName,
    });
  } catch {
    // Label doesn't exist — create it
    await octokit.issues.createLabel({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      name: labelName,
      color: '0075ca', // blue
      description: `Synced to Jira as ${jiraKey}`,
    });
  }

  await octokit.issues.addLabels({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    labels: [labelName],
  });
}

async function closeIssueAsMigrated(issueNumber, jiraKey) {
  const jiraUrl = `${JIRA_BASE_URL}/browse/${jiraKey}`;

  const comment = [
    `## ✅ Migrated to Jira`,
    ``,
    `This issue has been automatically synced to Jira as **[${jiraKey}](${jiraUrl})**.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Jira Ticket** | [${jiraKey}](${jiraUrl}) |`,
    `| **Project** | \`${JIRA_PROJECT_KEY}\` |`,
    `| **Synced at** | ${new Date().toISOString()} |`,
    ``,
    `_This GitHub issue is now closed. All further discussion and tracking happens in Jira._`,
  ].join('\n');

  log(`Closing GH issue #${issueNumber} as migrated → ${jiraKey}`);

  if (dryRun) {
    log(`[DRY RUN] Would post comment and close issue #${issueNumber}`);
    return;
  }

  await octokit.issues.createComment({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    body: comment,
  });

  await octokit.issues.update({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'not_planned', // "migrated" isn't a valid GH state_reason; not_planned is closest
  });
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

async function syncIssue(issueNumber) {
  log(`\n── Processing GH issue #${issueNumber} ──`);

  const { data: issue } = await octokit.issues.get({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
  });

  // Primary guard: check for existing jira: label
  const existingKey = getExistingJiraKey(issue.labels);
  if (existingKey) {
    log(`⏭  Issue #${issueNumber} already synced as ${existingKey} — skipping`);
    return { skipped: true, jiraKey: existingKey };
  }

  // Skip if already closed
  if (issue.state === 'closed') {
    log(`⏭  Issue #${issueNumber} is already closed — skipping`);
    return { skipped: true };
  }

  // Create Jira issue
  const jiraKey = await createJiraIssue(issue);
  log(`✅ Created Jira issue: ${jiraKey}`);

  // Tag GH issue with the Jira key label
  await addJiraLabel(issueNumber, jiraKey);

  // Close GH issue as migrated
  await closeIssueAsMigrated(issueNumber, jiraKey);

  log(`🎉 Issue #${issueNumber} → ${jiraKey} — done`);
  return { synced: true, jiraKey };
}

async function bulkSyncAllUnsynced() {
  log('🔍 Bulk sync: fetching all open issues without a jira: label...');
  const results = { synced: 0, skipped: 0, failed: 0 };
  let page = 1;

  while (true) {
    const { data: issues } = await octokit.issues.listForRepo({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      state: 'open',
      per_page: 100,
      page,
    });

    if (issues.length === 0) break;

    for (const issue of issues) {
      // Skip PRs (GH API returns them in issues endpoint)
      if (issue.pull_request) continue;

      const alreadySynced = getExistingJiraKey(issue.labels);
      if (alreadySynced) {
        results.skipped++;
        continue;
      }

      try {
        await syncIssue(issue.number);
        results.synced++;
        // Rate limit courtesy pause between creates
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        log(`❌ Failed to sync issue #${issue.number}: ${err.message}`);
        results.failed++;
      }
    }

    if (issues.length < 100) break;
    page++;
  }

  return results;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function log(...args) {
  console.log(...args);
}

async function main() {
  log(`🚀 TODO→ISSUE Jira Sync`);
  log(`   Repo:         ${GH_REPO}`);
  log(`   Jira project: ${JIRA_PROJECT_KEY}`);
  log(`   Jira URL:     ${JIRA_BASE_URL}`);
  log(`   Dry run:      ${dryRun}`);
  log(`   Bulk sync:    ${bulkSync}`);

  if (bulkSync) {
    const results = await bulkSyncAllUnsynced();
    log(`\n📊 Bulk sync complete:`);
    log(`   Synced:  ${results.synced}`);
    log(`   Skipped: ${results.skipped}`);
    log(`   Failed:  ${results.failed}`);

    if (results.failed > 0) {
      process.exit(1);
    }
  } else {
    if (!GH_ISSUE_NUMBER) throw new Error('GH_ISSUE_NUMBER is required for single-issue sync');
    await syncIssue(parseInt(GH_ISSUE_NUMBER, 10));
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
