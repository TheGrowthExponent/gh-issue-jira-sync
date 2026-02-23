/**
 * sync.js — GitHub Issue → Jira Sync
 *
 * Part of the TheGrowthExponent/gh-issue-jira-sync public GitHub Action.
 * Generic — works with any GitHub repo and any Jira cloud instance.
 *
 * Sync key:  A label `jira:PROJ-123` on the GH issue.
 *            Present  → already synced, skip.
 *            Absent   → create Jira ticket, add label, optionally close issue.
 *
 * Inputs via environment variables (set by the GHA workflow):
 *   GITHUB_TOKEN, GH_REPO, GH_ISSUE_NUMBER
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 *   DRY_RUN, BULK_SYNC, CLOSE_AFTER_SYNC, JIRA_ISSUE_TYPE_DEFAULT
 */

import { Octokit } from '@octokit/rest';

// ─── Environment ────────────────────────────────────────────────────────────────

const ENV = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_REPO: process.env.GH_REPO,
  GH_ISSUE_NUMBER: process.env.GH_ISSUE_NUMBER,
  JIRA_BASE_URL: (process.env.JIRA_BASE_URL || '').replace(/\/$/, ''),
  JIRA_USER_EMAIL: process.env.JIRA_USER_EMAIL,
  JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
  JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY,
  DRY_RUN: process.env.DRY_RUN === 'true',
  BULK_SYNC: process.env.BULK_SYNC === 'true',
  CLOSE_AFTER_SYNC: process.env.CLOSE_AFTER_SYNC !== 'false', // default true
  JIRA_ISSUE_TYPE_DEFAULT: process.env.JIRA_ISSUE_TYPE_DEFAULT || 'Task',
};

// Validate required vars
for (const key of [
  'GITHUB_TOKEN',
  'GH_REPO',
  'JIRA_BASE_URL',
  'JIRA_USER_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
]) {
  if (!ENV[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const [GH_OWNER, GH_REPO_NAME] = ENV.GH_REPO.split('/');
const octokit = new Octokit({ auth: ENV.GITHUB_TOKEN });

const JIRA_AUTH = Buffer.from(`${ENV.JIRA_USER_EMAIL}:${ENV.JIRA_API_TOKEN}`).toString('base64');
const JIRA_HEADERS = {
  Authorization: `Basic ${JIRA_AUTH}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

// ─── Mappings ───────────────────────────────────────────────────────────────────

// GitHub priority label → Jira priority name
// These match default Jira priority schemes — customise if your scheme differs
const PRIORITY_MAP = {
  'priority:critical': 'Highest',
  'priority:high': 'High',
  'priority:medium': 'Medium',
  'priority:low': 'Low',
};

// GitHub type label → Jira issue type
// Add your own mappings here or in a .todo-issue.yml config
const TYPE_MAP = {
  security: 'Bug',
  bug: 'Bug',
  'tech-debt': 'Task',
  enhancement: 'Story',
  feature: 'Story',
};

// ─── Label helpers ───────────────────────────────────────────────────────────────

/** Returns the Jira key if a `jira:PROJ-123` label exists, otherwise null */
function getJiraKeyFromLabels(labels = []) {
  const match = labels.find((l) => /^jira:[A-Z][A-Z0-9]+-\d+$/.test(l.name));
  return match ? match.name.slice(5) : null; // strip 'jira:'
}

function derivePriority(labels = []) {
  for (const l of labels) {
    if (PRIORITY_MAP[l.name]) return PRIORITY_MAP[l.name];
  }
  return 'Medium';
}

function deriveIssueType(labels = []) {
  for (const l of labels) {
    if (TYPE_MAP[l.name]) return TYPE_MAP[l.name];
  }
  return ENV.JIRA_ISSUE_TYPE_DEFAULT;
}

// ─── Body parsing ────────────────────────────────────────────────────────────────

/**
 * Extracts structured fields from the TODO→ISSUE markdown table in the GH body.
 * Falls back gracefully if the body is freeform (the action works on any GH issue).
 */
function parseBody(body = '') {
  const field = (name) => {
    const re = new RegExp(`\\|\\s*${name}\\s*\\|\\s*\`?([^\`|\\n]+?)\`?\\s*\\|`);
    const m = body.match(re);
    return m ? m[1].trim() : null;
  };

  const todoMatch = body.match(/##\s*TODO Comment\s*\n+>\s*(.+)/);
  const codeMatch = body.match(/##\s*Code Context\s*\n+(```[\s\S]*?```)/);

  return {
    todoText: todoMatch ? todoMatch[1].trim() : null,
    codeBlock: codeMatch ? codeMatch[1] : null,
    file: field('File'),
    line: field('Line'),
    branch: field('Branch'),
    commit: field('Commit'),
    introduced: field('Introduced'),
    author: field('Author'),
  };
}

// ─── Jira ADF description builder ───────────────────────────────────────────────

function adfTableRow(cells, header = false) {
  return {
    type: 'tableRow',
    content: cells.map((text) => ({
      type: header ? 'tableHeader' : 'tableCell',
      attrs: {},
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: String(text ?? '') }],
        },
      ],
    })),
  };
}

function buildDescription(issue, meta) {
  const ghUrl = issue.html_url;
  const todoText = meta.todoText || issue.title;

  const metaRows = [
    meta.file && ['File', meta.file],
    meta.line && ['Line', meta.line],
    meta.branch && ['Branch', meta.branch],
    meta.commit && ['Commit', meta.commit],
    meta.introduced && ['Introduced', meta.introduced],
    meta.author && ['Author', meta.author],
    ['GitHub Issue', ghUrl],
  ].filter(Boolean);

  const content = [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Auto-migrated from GitHub Issues by ',
          marks: [{ type: 'em' }],
        },
        {
          type: 'text',
          text: 'gh-issue-jira-sync',
          marks: [{ type: 'em' }, { type: 'strong' }],
        },
        { type: 'text', text: '.', marks: [{ type: 'em' }] },
      ],
    },
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: todoText }] }],
    },
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Details' }],
    },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [
        adfTableRow(['Field', 'Value'], true),
        ...metaRows.map(([k, v]) => adfTableRow([k, v])),
      ],
    },
  ];

  if (meta.codeBlock) {
    const lang = (meta.codeBlock.match(/```(\w+)/) || [])[1] || 'text';
    const code = meta.codeBlock.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    content.push(
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: 'Code Context' }],
      },
      {
        type: 'codeBlock',
        attrs: { language: lang },
        content: [{ type: 'text', text: code }],
      }
    );
  }

  return { version: 1, type: 'doc', content };
}

// ─── Jira API ───────────────────────────────────────────────────────────────────

async function jira(method, path, body) {
  const url = `${ENV.JIRA_BASE_URL}/rest/api/3${path}`;
  const res = await fetch(url, {
    method,
    headers: JIRA_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${method} ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function createJiraIssue(issue) {
  const labels = issue.labels || [];
  const priority = derivePriority(labels);
  const issueType = deriveIssueType(labels);
  const meta = parseBody(issue.body);

  // Clean up the summary — strip [TODO][P1 CRITICAL] prefix if present
  const summary = issue.title
    .replace(/^\[[^\]]*\]\s*/g, '')
    .trim()
    .substring(0, 255);

  const payload = {
    fields: {
      project: { key: ENV.JIRA_PROJECT_KEY },
      summary,
      description: buildDescription(issue, meta),
      issuetype: { name: issueType },
      priority: { name: priority },
      labels: ['auto-migrated', 'gh-issue-jira-sync'],
    },
  };

  log(`  Creating Jira ${issueType} [${priority}]: '${summary}'`);

  if (ENV.DRY_RUN) {
    log('  [DRY RUN] Skipping Jira API call');
    log('  Payload:', JSON.stringify(payload, null, 2));
    return `${ENV.JIRA_PROJECT_KEY}-DRY`;
  }

  const result = await jira('POST', '/issue', payload);
  return result.key;
}

// ─── GitHub operations ──────────────────────────────────────────────────────────

async function ensureLabel(name, color = '0075ca', description = '') {
  try {
    await octokit.issues.getLabel({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      name,
    });
  } catch {
    await octokit.issues.createLabel({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      name,
      color,
      description,
    });
  }
}

async function applyJiraLabel(issueNumber, jiraKey) {
  const name = `jira:${jiraKey}`;
  log(`  Applying label '${name}' to issue #${issueNumber}`);
  if (ENV.DRY_RUN) {
    log('  [DRY RUN] Skipping label creation');
    return;
  }
  await ensureLabel(name, '0075ca', `Synced to Jira as ${jiraKey}`);
  await octokit.issues.addLabels({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    labels: [name],
  });
}

async function closeIssue(issueNumber, jiraKey) {
  const jiraUrl = `${ENV.JIRA_BASE_URL}/browse/${jiraKey}`;
  const body = [
    '## ✅ Synced to Jira',
    '',
    `This issue has been automatically migrated to Jira as **[${jiraKey}](${jiraUrl})**.`,
    '',
    '| | |',
    '|---|---|',
    `| **Jira ticket** | [${jiraKey}](${jiraUrl}) |`,
    `| **Project** | \`${ENV.JIRA_PROJECT_KEY}\` |`,
    `| **Synced** | ${new Date().toISOString()} |`,
    '',
    '_This GitHub issue is now closed. All tracking continues in Jira._',
  ].join('\n');

  log(`  Closing issue #${issueNumber} → ${jiraKey}`);
  if (ENV.DRY_RUN) {
    log('  [DRY RUN] Skipping close');
    return;
  }

  await octokit.issues.createComment({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    body,
  });
  await octokit.issues.update({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'not_planned',
  });
}

// ─── Core sync ──────────────────────────────────────────────────────────────────

async function syncIssue(issueNumber) {
  log(`\n── Issue #${issueNumber} ──`);

  const { data: issue } = await octokit.issues.get({
    owner: GH_OWNER,
    repo: GH_REPO_NAME,
    issue_number: issueNumber,
  });

  const existingKey = getJiraKeyFromLabels(issue.labels);
  if (existingKey) {
    log(`  ⏭  Already synced as ${existingKey} — skipping`);
    return {
      status: 'skipped',
      reason: 'already_synced',
      jiraKey: existingKey,
    };
  }

  if (issue.state === 'closed') {
    log('  ⏭  Issue is closed — skipping');
    return { status: 'skipped', reason: 'already_closed' };
  }

  const jiraKey = await createJiraIssue(issue);
  log(`  ✅ Created: ${jiraKey}`);

  await applyJiraLabel(issueNumber, jiraKey);

  if (ENV.CLOSE_AFTER_SYNC) {
    await closeIssue(issueNumber, jiraKey);
  }

  // Write output for GHA
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('fs');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `jira_key=${jiraKey}\n`);
  }

  log(`  🎉 Done → ${jiraKey}`);
  return { status: 'synced', jiraKey };
}

async function bulkSync() {
  log('🔍 Bulk sync — fetching all open issues without a jira: label...');
  const summary = { synced: 0, skipped: 0, failed: 0 };

  for (let page = 1; ; page++) {
    const { data: issues } = await octokit.issues.listForRepo({
      owner: GH_OWNER,
      repo: GH_REPO_NAME,
      state: 'open',
      per_page: 100,
      page,
    });
    if (!issues.length) break;

    for (const issue of issues) {
      if (issue.pull_request) continue; // GH API returns PRs here too

      try {
        const result = await syncIssue(issue.number);
        result.status === 'synced' ? summary.synced++ : summary.skipped++;
        if (result.status === 'synced') await new Promise((r) => setTimeout(r, 400)); // rate limit courtesy
      } catch (err) {
        log(`  ❌ #${issue.number}: ${err.message}`);
        summary.failed++;
      }
    }
    if (issues.length < 100) break;
  }

  return summary;
}

// ─── Entry point ────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(...args);
}

async function main() {
  log('🚀 gh-issue-jira-sync');
  log(`   Repo:         ${ENV.GH_REPO}`);
  log(`   Jira project: ${ENV.JIRA_PROJECT_KEY}`);
  log(`   Jira URL:     ${ENV.JIRA_BASE_URL}`);
  log(`   Dry run:      ${ENV.DRY_RUN}`);
  log(`   Bulk sync:    ${ENV.BULK_SYNC}`);
  log(`   Close after:  ${ENV.CLOSE_AFTER_SYNC}`);

  if (ENV.BULK_SYNC) {
    const s = await bulkSync();
    log(
      `\n📊 Bulk sync complete — synced: ${s.synced}, skipped: ${s.skipped}, failed: ${s.failed}`
    );
    if (s.failed > 0) process.exit(1);
  } else {
    if (!ENV.GH_ISSUE_NUMBER) throw new Error('GH_ISSUE_NUMBER required for single-issue sync');
    await syncIssue(parseInt(ENV.GH_ISSUE_NUMBER, 10));
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
