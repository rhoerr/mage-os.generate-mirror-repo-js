/**
 * Run with
 *
 * node bin/package-ledger.js verify --ledger=resource/ledger/mirror.tsv --satisOutputDir=build --repoUrl=https://mirror.mage-os.org/
 */

const fs = require('fs');
const path = require('path');
const parseOptions = require('parse-options');
const ledger = require('../src/package-ledger');
const refLedger = require('../src/ref-ledger');

const options = parseOptions(
  `command $ledger $satisOutputDir $packagesDir $repoUrl $baseUrl $mode $expectDiff $times $defaultTime $target $mageosRelease $publishTag $refs $pendingRefs @allowAliasRepoint @incremental @update @checkTimes @help|h`,
  process.argv
);

const commands = {guard, base, seed, verify, audit, bootstrap};

if (options.help || !commands[options.command] || !options.ledger) {
  console.log(`Maintain and check the package ledger of a composer repository.

Usage:
  node bin/package-ledger.js COMMAND --ledger=FILE [OPTIONS]

Commands:
  guard      Check the inputs of a deploy before anything is built
  base       Fetch the packages.json and include files of the live repository into an empty satis output dir,
             for an incremental build, and check them against the ledger
  seed       Write the published-time of every ledger entry into an empty satis output dir, before running satis
  verify     Compare the packages satis was run over against the ledger, before deploying them
  audit      Compare the metadata a live repository serves against the ledger
  bootstrap  Create the ledger of a repository that is already live

Options:
  --ledger=            The ledger file, for example resource/ledger/mirror.tsv
  --satisOutputDir=    base, seed, verify: The satis output dir (default: build)
  --packagesDir=       verify: The dir containing the package archives (default: {satisOutputDir}/packages)
  --repoUrl=           base, verify, audit, bootstrap: Repository base URL (for example https://mirror.mage-os.org/)
  --baseUrl=           base: Where to fetch the live metadata from (default: --repoUrl)
  --mode=              verify: "gate" fails on changed or missing published packages, "report" only lists them (default: gate)
  --expectDiff=        verify: Comma separated globs of archive paths that are expected to differ from the ledger
  --allowAliasRepoint  verify: Accept changed magento/* alias metapackages that require the highest mage-os/* version
                       replacing them in this build
  --incremental        verify: Check versions without an archive in --packagesDir by their metadata,
                       as an incremental build only contains the archives it built
  --update             verify: Write new and changed versions to the ledger if the gate passed
  --refs=              verify: The ref ledger to add the tags in --pendingRefs to on --update,
                       for example resource/ledger/mirror-refs.tsv
  --pendingRefs=       verify: The tags the generator processed (its --refsOut file). Only tags all of whose
                       versions are in the updated ledger are recorded
  --checkTimes         audit: Also check the p2 metadata composer 2 reads, including the published-time of
                       every version (one request per package)
  --target=            guard: "production" or "preview"
  --mageosRelease=     guard: The Mage-OS release the deploy builds, if any
  --publishTag=        guard: "true" if the deploy publishes the release tag, otherwise "false"
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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
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

async function guard() {
  const target = requireOption('target');
  if (!['production', 'preview'].includes(target)) {
    throw new Error(`Unknown target "${target}"`);
  }
  if (!['true', 'false'].includes(options.publishTag)) {
    throw new Error('--publishTag must be "true" or "false"');
  }
  const failures = ledger.guardFailures(ledger.readLedger(options.ledger), {
    target,
    mageosRelease: options.mageosRelease || '',
    publishTag: options.publishTag === 'true',
  });
  failures.length > 0 ? fail(failures) : console.log('Deploy inputs are fine');
}

async function base() {
  const repoUrl = requireOption('repoUrl');
  const baseUrl = options.baseUrl || repoUrl;
  const rows = ledger.readLedger(options.ledger);
  let checked;
  try {
    const files = await ledger.fetchBaseMetadata(baseUrl, fetchText);
    checked = {files, ...ledger.baseMetadataFailures(rows, files, repoUrl)};
  } catch (exception) {
    checked = {failures: [exception.message || String(exception)]};
  }
  checked.results && report(checked.results, `Live metadata of ${baseUrl} against ${path.basename(options.ledger)}`);
  if (checked.failures.length > 0) {
    fail([
      ...checked.failures,
      `The live metadata of ${baseUrl} does not match the ledger, so an incremental build can not be based on it. Deploy with full_rebuild`,
    ]);
    return;
  }
  ledger.writeBaseMetadata(checked.files, options.satisOutputDir || 'build');
  console.log(`Wrote the live metadata of ${rows.length} versions to ${options.satisOutputDir || 'build'}`);
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
  if (options.pendingRefs && !(options.update && options.refs)) {
    throw new Error('--pendingRefs requires --update and --refs');
  }
  const satisOutputDir = options.satisOutputDir || 'build';
  const results = await ledger.verifyBuild(ledger.readLedger(options.ledger), {
    satisOutputDir,
    packagesDir: options.packagesDir || path.join(satisOutputDir, 'packages'),
    repoUrl: requireOption('repoUrl'),
    expectDiff: (options.expectDiff || '').split(',').filter(Boolean),
    allowAliasRepoint: options.allowAliasRepoint,
    incremental: options.incremental,
  });
  report(results, `Package ledger ${path.basename(options.ledger)} (${mode})`);

  const failures = ledger.gateFailures(results);
  if (mode === 'gate' && failures.length > 0) {
    return fail(failures);
  }
  if (options.update) {
    const rows = ledger.nextRows(results);
    if (options.pendingRefs) {
      const pending = JSON.parse(fs.readFileSync(options.pendingRefs, 'utf8'));
      const merged = refLedger.mergeRefs(refLedger.readRefs(options.refs), pending, rows);
      refLedger.writeRefs(options.refs, merged.rows);
      console.log(`Recorded ${merged.recorded} tags in ${options.refs}`);
      merged.notPublished.forEach(ref => console.log(`Not recorded, it built versions that are not in the ledger: ${ref}`));
    }
    ledger.writeLedger(options.ledger, rows);
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
