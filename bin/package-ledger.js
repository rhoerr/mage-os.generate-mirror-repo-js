/**
 * Run with
 *
 * node bin/package-ledger.js verify --ledger=resource/ledger/mirror.tsv --satisOutputDir=build --repoUrl=https://mirror.mage-os.org/
 */

const fs = require('fs');
const path = require('path');
const parseOptions = require('parse-options');
const ledger = require('../src/package-ledger');

const options = parseOptions(
  `command $ledger $satisOutputDir $packagesDir $repoUrl $mode $expectDiff $times $defaultTime @allowChanges @allowAliasRepoint @update @checkTimes @help|h`,
  process.argv
);

const commands = {seed, verify, audit, bootstrap};

if (options.help || !commands[options.command] || !options.ledger) {
  console.log(`Maintain and check the package ledger of a composer repository.

Usage:
  node bin/package-ledger.js COMMAND --ledger=FILE [OPTIONS]

Commands:
  seed       Write the published-time of every ledger entry into an empty satis output dir, before running satis
  verify     Compare the packages satis was run over against the ledger, before deploying them
  audit      Compare the metadata a live repository serves against the ledger
  bootstrap  Create the ledger of a repository that is already live

Options:
  --ledger=            The ledger file, for example resource/ledger/mirror.tsv
  --satisOutputDir=    seed, verify: The satis output dir (default: build)
  --packagesDir=       verify: The dir containing the package archives (default: {satisOutputDir}/packages)
  --repoUrl=           verify, audit, bootstrap: Repository base URL (for example https://mirror.mage-os.org/)
  --mode=              verify: "gate" fails on changed or missing published packages, "report" only lists them (default: gate)
  --expectDiff=        verify: Comma separated globs of archive paths that are expected to differ from the ledger
  --allowChanges       verify: Do not fail on changed or missing published packages
  --allowAliasRepoint  verify: Accept changed alias metapackages that now require a package version new in this build
  --update             verify: Write new and changed versions to the ledger if the gate passed
  --checkTimes         audit: Also check the p2 metadata composer 2 reads, including the published-time of
                       every version (one request per package)
  --times=             bootstrap: TSV file with name, version, published-time and source of known publication times
  --defaultTime=       bootstrap: published-time for versions not listed in --times
`);
  process.exit(1);
}

function requireOption(name) {
  if (!options[name]) {
    throw new Error(`--${name} is required for ${options.command}`);
  }
  return options[name];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), {status: response.status});
  }
  return response.json();
}

function report(results, title) {
  console.log(ledger.formatReport(results, {title}));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ledger.formatReport(results, {title, markdown: true, limit: 2000}) + '\n');
  }
}

function fail(failures) {
  failures.forEach(failure => console.log(`FAILED: ${failure}`));
  process.exitCode = 1;
}

async function seed() {
  const count = ledger.writeSeeds(ledger.readLedger(options.ledger), options.satisOutputDir || 'build');
  console.log(`Seeded published-time for ${count} package metadata files`);
}

async function verify() {
  const mode = options.mode || 'gate';
  if (!['gate', 'report'].includes(mode)) {
    throw new Error(`Unknown mode "${mode}"`);
  }
  if (options.update && mode !== 'gate') {
    throw new Error('--update requires --mode=gate');
  }
  const satisOutputDir = options.satisOutputDir || 'build';
  const results = await ledger.verifyBuild(ledger.readLedger(options.ledger), {
    satisOutputDir,
    packagesDir: options.packagesDir || path.join(satisOutputDir, 'packages'),
    repoUrl: requireOption('repoUrl'),
    expectDiff: (options.expectDiff || '').split(',').filter(Boolean),
    allowAliasRepoint: options.allowAliasRepoint,
  });
  report(results, `Package ledger ${path.basename(options.ledger)} (${mode})`);

  const failures = ledger.gateFailures(results, {allowChanges: options.allowChanges});
  if (mode === 'gate' && failures.length > 0) {
    return fail(failures);
  }
  if (options.update) {
    ledger.writeLedger(options.ledger, ledger.nextRows(results));
    console.log(`Updated ${options.ledger}`);
  }
}

async function audit() {
  const repoUrl = requireOption('repoUrl');
  const rows = ledger.readLedger(options.ledger);
  for (const fromMetadataUrl of options.checkTimes ? [false, true] : [false]) {
    const source = fromMetadataUrl ? 'p2 metadata' : 'include files';
    const entries = await ledger.fetchRepoEntries(repoUrl, fetchJson, {fromMetadataUrl});
    const results = ledger.classify(rows, entries);
    report(results, `Package ledger ${path.basename(options.ledger)} audit of ${repoUrl} ${source}`);

    const {unchanged, problems} = ledger.summarize(results);
    if (unchanged !== results.length || problems > 0) {
      fail([`The ${source} of ${repoUrl} do not match the ledger`]);
    }
  }
}

async function bootstrap() {
  if (fs.existsSync(options.ledger)) {
    throw new Error(`${options.ledger} already exists`);
  }
  const times = options.times ? ledger.parseTimes(fs.readFileSync(options.times, 'utf8')) : new Map();
  const entries = await ledger.fetchRepoEntries(requireOption('repoUrl'), fetchJson);
  const rows = ledger.bootstrapRows(entries, times, {defaultTime: options.defaultTime});
  ledger.writeLedger(options.ledger, rows);

  const bySource = {};
  rows.forEach(row => bySource[row.source] = (bySource[row.source] || 0) + 1);
  console.log(`Wrote ${rows.length} versions to ${options.ledger}`, bySource);
}

commands[options.command]().catch(exception => {
  console.log(exception.message || exception);
  process.exit(2);
});
