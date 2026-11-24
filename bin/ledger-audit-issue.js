/**
 * Run with
 *
 * node bin/ledger-audit-issue.js --ledger=mirror --repoUrl=https://mirror.mage-os.org/ --outcome=failure --log=audit.log
 *
 * in a GitHub Actions job, with GH_TOKEN and GH_REPO set for the gh CLI.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const parseOptions = require('parse-options');

const LABEL = 'ledger-audit';
const TEAM = '@mage-os/infrastructure';
const MAX_LINES = 100;
const MAX_BYTES = 12000;
const MARKER = /^<!-- ledger-audit-output: ([0-9a-f]+) -->/;

const options = parseOptions(`$ledger $repoUrl $outcome $log @help|h`, process.argv);

if (options.help || !options.ledger || !options.repoUrl || !options.log || !['success', 'failure'].includes(options.outcome)) {
  console.log(`Open, update or close the GitHub issue for the package ledger audit.
Usage:
  node bin/ledger-audit-issue.js [OPTIONS]

Options:
  --ledger=   The audited ledger, for example mirror
  --repoUrl=  The audited composer repository
  --outcome=  The outcome of the audit step, "success" or "failure"
  --log=      The output of the audit
`);
  process.exit(1);
}

const title = `Package ledger audit failed: ${options.ledger}`;
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-audit-issue-'));

function gh(...args) {
  return execFileSync('gh', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
}

function ghWithBody(args, body) {
  const file = path.join(tmpDir, 'body.md');
  fs.writeFileSync(file, body);
  return gh(...args, '--body-file', file);
}

// The audit output repeats what a possibly tampered server serves, so it goes in a code fence it cannot close
function outputBlock(log) {
  const lines = log.toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd().split('\n');
  let text = lines.slice(-MAX_LINES).join('\n');
  if (Buffer.byteLength(text) > MAX_BYTES) {
    text = Buffer.from(text).subarray(-MAX_BYTES).toString('utf8').replace(/^�+/, '');
  }
  const longestBackticks = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestBackticks + 1));
  return `Last lines of the audit output, the full report is in the run:\n\n${fence}\n${text}\n${fence}\n`;
}

// Not gh issue list, which searches and can miss an issue opened moments ago
const issue = JSON.parse(gh('api', `repos/{owner}/{repo}/issues?labels=${LABEL}&state=open&per_page=100`))
  .find(candidate => candidate.title === title);

if (options.outcome === 'success') {
  if (issue) {
    ghWithBody(['issue', 'comment', String(issue.number)], `The package ledger audit passes again: ${runUrl}\n`);
    gh('issue', 'close', String(issue.number));
    console.log(`Closed #${issue.number}`);
  }
  process.exit(0);
}

const log = fs.readFileSync(options.log);
const hash = crypto.createHash('sha256').update(log).digest('hex');
const marker = `<!-- ledger-audit-output: ${hash} -->`;

if (!issue) {
  gh('label', 'create', LABEL, '--force', '--color', 'B60205', '--description', 'The daily package ledger audit failed');
  process.stdout.write(ghWithBody(['issue', 'create', '--title', title, '--label', LABEL], `${marker}
${TEAM} The package ledger audit of ${options.repoUrl} failed. A difference from the ledger can mean that the server was tampered with.

Run: ${runUrl}

${outputBlock(log)}`));
} else if (((issue.body || '').match(MARKER) || [])[1] === hash) {
  console.log(`The audit output is the same as last reported on #${issue.number}`);
} else {
  ghWithBody(['issue', 'comment', String(issue.number)], `The package ledger audit still fails, with different output: ${runUrl}

${outputBlock(log)}`);
  ghWithBody(['issue', 'edit', String(issue.number)], MARKER.test(issue.body || '') ? issue.body.replace(MARKER, marker) : `${marker}\n${issue.body || ''}`);
  console.log(`Commented on #${issue.number}`);
}
