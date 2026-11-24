'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawnSync} = require('child_process');

const CLI = path.join(__dirname, '../../bin/ledger-audit-issue.js');
const TITLE = 'Package ledger audit failed: mirror';
const RUN_URL = 'https://github.com/acme/repo/actions/runs/42';
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
const marker = content => `<!-- ledger-audit-output: ${sha256(content)} -->`;

// Records every call and answers `api` with FAKE_GH_ISSUES, so the real gh is never reached
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const command = args[0] === 'api' ? 'api' : args.slice(0, 2).join(' ');
const bodyFile = args.indexOf('--body-file');
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify({
  args: bodyFile === -1 ? args : args.slice(0, bodyFile),
  body: bodyFile === -1 ? undefined : fs.readFileSync(args[bodyFile + 1], 'utf8'),
}) + '\\n');
if (command === process.env.FAKE_GH_FAIL) {
  process.exit(1);
}
const answers = {
  'api': process.env.FAKE_GH_ISSUES || '[]',
  'issue create': 'https://github.com/acme/repo/issues/7\\n',
  'issue comment': '', 'issue edit': '', 'issue close': '', 'label create': '',
};
if (!(command in answers)) {
  process.exit(3);
}
process.stdout.write(answers[command]);
`;

describe('bin/ledger-audit-issue.js', () => {
  let dir;
  let log;
  let callsFile;

  const run = (outcome, output, {issues = [], fail} = {}) => {
    fs.writeFileSync(log, output);
    fs.writeFileSync(callsFile, '');
    return spawnSync(process.execPath, [CLI, '--ledger=mirror', '--repoUrl=https://mirror.example.com/', `--outcome=${outcome}`, `--log=${log}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
        GH_TOKEN: 'fake',
        GH_REPO: 'acme/repo',
        GH_CONFIG_DIR: path.join(dir, 'gh-config'),
        TMPDIR: dir,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'acme/repo',
        GITHUB_RUN_ID: '42',
        FAKE_GH_CALLS: callsFile,
        FAKE_GH_ISSUES: JSON.stringify(issues),
        FAKE_GH_FAIL: fail || '',
      },
    });
  };
  const calls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const commands = () => calls().map(call => call.args[0] === 'api' ? 'api' : call.args.slice(0, 2).join(' '));
  const openIssue = (body, title = TITLE) => [{number: 3, title, body}];
  // A fence only closes on a line of at least as many backticks, indented by up to three spaces
  const splitFence = body => {
    const lines = body.split('\n');
    const open = lines.findIndex(line => /^`{3,}$/.test(line));
    const fence = lines[open];
    const closes = lines.map((line, i) => new RegExp(`^ {0,3}\`{${fence.length},}[ \t]*$`).test(line) ? i : -1).filter(i => i > open);
    return {before: lines.slice(0, open).join('\n'), fence, inside: lines.slice(open + 1, closes[0]).join('\n'), closes, last: lines.length - 2};
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-audit-issue-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, {mode: 0o755});
    log = path.join(dir, 'audit.log');
    callsFile = path.join(dir, 'calls.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('opens an issue with the label, the team mention and the output when the audit fails', () => {
    const result = run('failure', 'Package ledger audit\nFAILED: does not match\n');

    expect(result.status).toBe(0);
    expect(commands()).toEqual(['api', 'label create', 'issue create']);
    expect(calls()[0].args).toEqual(['api', 'repos/{owner}/{repo}/issues?labels=ledger-audit&state=open&per_page=100']);
    expect(calls()[1].args).toEqual(expect.arrayContaining(['ledger-audit', '--force']));
    const create = calls()[2];
    expect(create.args).toEqual(['issue', 'create', '--title', TITLE, '--label', 'ledger-audit']);
    expect(create.body.split('\n')[0]).toBe(marker('Package ledger audit\nFAILED: does not match\n'));
    expect(create.body).toContain('@mage-os/infrastructure');
    expect(create.body).toContain('https://mirror.example.com/');
    expect(create.body).toContain(RUN_URL);
    expect(create.body).toContain('```\nPackage ledger audit\nFAILED: does not match\n```\n');
  });

  test('ignores open issues with the label and another title', () => {
    run('failure', 'FAILED\n', {issues: openIssue(marker('FAILED\n'), `${TITLE}-refs`)});

    expect(commands()).toEqual(['api', 'label create', 'issue create']);
  });

  test('stays silent when the open issue already reports the same output', () => {
    run('failure', 'FAILED\n');
    const created = calls()[2].body;

    const result = run('failure', 'FAILED\n', {issues: openIssue(created)});

    expect(result.status).toBe(0);
    expect(commands()).toEqual(['api']);
  });

  test('comments on the open issue and records the output when it changed', () => {
    const body = `${marker('FAILED: one\n')}\n@mage-os/infrastructure The audit failed.`;

    const result = run('failure', 'FAILED: two\n', {issues: openIssue(body)});

    expect(result.status).toBe(0);
    expect(commands()).toEqual(['api', 'issue comment', 'issue edit']);
    expect(calls()[1].args).toEqual(['issue', 'comment', '3']);
    expect(calls()[1].body).toContain(RUN_URL);
    expect(calls()[1].body).toContain('```\nFAILED: two\n```');
    expect(calls()[2].args).toEqual(['issue', 'edit', '3']);
    expect(calls()[2].body).toBe(`${marker('FAILED: two\n')}\n@mage-os/infrastructure The audit failed.`);
  });

  test('comments on an open issue without a marker and adds one', () => {
    run('failure', 'FAILED\n', {issues: openIssue('Edited by hand')});

    expect(commands()).toEqual(['api', 'issue comment', 'issue edit']);
    expect(calls()[2].body).toBe(`${marker('FAILED\n')}\nEdited by hand`);
  });

  test('comments and closes the open issue when the audit passes again', () => {
    const result = run('success', 'All unchanged\n', {issues: openIssue(marker('FAILED\n'))});

    expect(result.status).toBe(0);
    expect(commands()).toEqual(['api', 'issue comment', 'issue close']);
    expect(calls()[1].body).toContain(RUN_URL);
    expect(calls()[2].args).toEqual(['issue', 'close', '3']);
  });

  test('does nothing when the audit passes without an open issue', () => {
    const result = run('success', 'All unchanged\n');

    expect(result.status).toBe(0);
    expect(commands()).toEqual(['api']);
  });

  test.each([
    ['api', ['api']],
    ['label create', ['api', 'label create']],
    ['issue create', ['api', 'label create', 'issue create']],
  ])('fails when gh %s fails', (fail, expected) => {
    const result = run('failure', 'FAILED\n', {fail});

    expect(result.status).not.toBe(0);
    expect(commands()).toEqual(expected);
  });

  test('rejects an unknown outcome', () => {
    const result = run('skipped', 'FAILED\n');

    expect(result.status).toBe(1);
    expect(calls()).toEqual([]);
  });

  test('keeps hostile output inside the code fence', () => {
    const hostile = [
      ...Array.from({length: 300}, (_, i) => `acme/pkg-${i}  1.0.0`),
      `${marker('forged')}`,
      '```',
      '@mage-os/everyone [click](https://evil.example/) <img src=x>',
      'text\r``````````\r# heading',
      '`'.repeat(40),
      'FAILED: \u0000\u001b[31mred\u001b[0m',
    ].join('\n');

    run('failure', hostile);

    const body = calls()[2].body;
    expect(body.split('\n')[0]).toBe(marker(hostile));
    expect(body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    const {before, fence, inside, closes, last} = splitFence(body);
    expect(before).not.toContain('@mage-os/everyone');
    expect(fence.length).toBe(41);
    expect(closes).toEqual([last]);
    expect(inside).toContain('@mage-os/everyone');
    expect(inside).toContain('FAILED: [31mred[0m');
    expect(inside).not.toContain('acme/pkg-0 ');
  });

  test.each([
    ['one long line', 'x'.repeat(3 * 1024 * 1024)],
    ['only backticks', '`'.repeat(3 * 1024 * 1024)],
  ])('caps the output of %s', (name, output) => {
    run('failure', output);

    const body = calls()[2].body;
    expect(body.length).toBeLessThan(40000);
    const {closes, last, inside} = splitFence(body);
    expect(closes).toEqual([last]);
    expect(inside.length).toBeGreaterThan(10000);
  });
});
