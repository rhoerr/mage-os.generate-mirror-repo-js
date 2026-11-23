/**
 * Package ledger: the git-committed record of every package version published to a composer repository.
 *
 * One line per version with its archive path, hashes and published-time. The ledger seeds the
 * published-time values satis emits, and is what a build is verified against before it is deployed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const {aliasTarget, newestReplacers, readComposerJsonFromZip} = require('./package-aliases');

const FIELDS = ['name', 'version', 'version_normalized', 'path', 'sha1', 'sha256', 'metadata-sha256', 'published-time', 'source'];
const SOURCES = ['upstream', 'tag', 'release', 'bootstrap', 'build'];

const STATUS = {
  UNCHANGED: 'unchanged',
  NEW: 'new',
  EXPECTED: 'expected',
  REPOINTED: 'repointed',
  MODIFIED: 'modified',
  MISSING: 'missing',
};

// The exact format satis writes, so ledger and satis output compare as strings.
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

const RELEASE_PACKAGE = 'mage-os/product-community-edition';

const NEW_VERSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function rowKey({name, version_normalized}) {
  return `${name} ${version_normalized}`;
}

function formatTime(date) {
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function versionSortKey(normalized) {
  const m = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(.*)$/);
  return m
    ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[5]]
    : [Infinity, 0, 0, 0, normalized];
}

function compareRows(a, b) {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  const ka = versionSortKey(a.version_normalized);
  const kb = versionSortKey(b.version_normalized);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) {
      return ka[i] < kb[i] ? -1 : 1;
    }
  }
  return 0;
}

function validateRow(row, context) {
  for (const field of FIELDS) {
    if (typeof row[field] !== 'string' || /[\t\n\r]/.test(row[field])) {
      throw new Error(`${context}: invalid ${field}`);
    }
  }
  if (!row.name || !row.version || !row.version_normalized || !row.path) {
    throw new Error(`${context}: name, version, version_normalized and path are required`);
  }
  if (!/^[0-9a-f]{40}$/.test(row.sha1)) {
    throw new Error(`${context}: invalid sha1`);
  }
  if (row.sha256 !== '' && !/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error(`${context}: invalid sha256`);
  }
  if (!/^[0-9a-f]{64}$/.test(row['metadata-sha256'])) {
    throw new Error(`${context}: invalid metadata-sha256`);
  }
  if (!TIME_PATTERN.test(row['published-time']) || Number.isNaN(Date.parse(row['published-time']))) {
    throw new Error(`${context}: published-time must be UTC in the form YYYY-MM-DDTHH:MM:SS+00:00`);
  }
  if (!SOURCES.includes(row.source)) {
    throw new Error(`${context}: unknown source "${row.source}"`);
  }
}

function assertUniqueKeys(rows, context) {
  const seen = new Set();
  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) {
      throw new Error(`${context}: duplicate entry for ${key}`);
    }
    seen.add(key);
  }
}

function parseLedger(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.shift() !== FIELDS.join('\t')) {
    throw new Error(`Ledger header must be: ${FIELDS.join(' ')}`);
  }
  const rows = lines.map((line, index) => {
    const values = line.split('\t');
    if (values.length !== FIELDS.length) {
      throw new Error(`Ledger line ${index + 2}: expected ${FIELDS.length} fields, found ${values.length}`);
    }
    const row = Object.fromEntries(FIELDS.map((field, i) => [field, values[i]]));
    validateRow(row, `Ledger line ${index + 2}`);
    return row;
  });
  assertUniqueKeys(rows, 'Ledger');
  return rows;
}

function formatLedger(rows) {
  rows.forEach(row => validateRow(row, `Ledger row ${rowKey(row)}`));
  assertUniqueKeys(rows, 'Ledger');
  const sorted = rows.slice().sort(compareRows);
  return [FIELDS.join('\t'), ...sorted.map(row => FIELDS.map(field => row[field]).join('\t'))].join('\n') + '\n';
}

function readLedger(file) {
  return parseLedger(fs.readFileSync(file, 'utf8'));
}

function writeLedger(file, rows) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, formatLedger(rows));
}

function isDevVersion({version}) {
  return /^dev-|-dev$/.test(version);
}

/**
 * Satis only knows published-time values from the p2 files already in its output directory, and
 * crashes on a previous entry without version_normalized.
 *
 * @returns {Object.<string, Object>} p2 file path relative to the satis output dir => file content
 */
function buildSeeds(rows) {
  const seeds = {};
  for (const row of rows.slice().sort(compareRows)) {
    const file = `p2/${row.name}${isDevVersion(row) ? '~dev' : ''}.json`;
    seeds[file] = seeds[file] || {packages: {[row.name]: []}};
    seeds[file].packages[row.name].push({
      version: row.version,
      version_normalized: row.version_normalized,
      'published-time': row['published-time'],
    });
  }
  return seeds;
}

function writeSeeds(rows, satisOutputDir) {
  const p2Dir = path.join(satisOutputDir, 'p2');
  if (fs.existsSync(p2Dir)) {
    throw new Error(`Refusing to seed: ${p2Dir} already exists`);
  }
  const seeds = buildSeeds(rows);
  for (const [file, data] of Object.entries(seeds)) {
    const target = path.join(satisOutputDir, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, JSON.stringify(data));
  }
  return Object.keys(seeds).length;
}

const METADATA_FIELDS = ['name', 'version', 'type', 'require', 'require-dev', 'replace', 'provide', 'conflict', 'suggest', 'autoload', 'extra', 'bin'];
const LINK_FIELDS = ['require', 'require-dev', 'replace', 'provide', 'conflict'];

// PHP decodes {} and [] to the same empty array, so satis metadata can not tell them apart.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return keys.length === 0 ? '[]' : '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === ''
    || (typeof value === 'object' && Object.keys(value).length === 0);
}

/**
 * Hash of the composer.json fields composer resolves with. It is the same for a package's composer.json
 * and for the metadata satis generated from it, so a satis upgrade does not change it.
 */
function metadataSha256(composer) {
  const selected = {};
  for (const field of METADATA_FIELDS) {
    // Composer loads a package without a type as a library, and lower-cases the type and the link targets
    let value = composer[field];
    if (field === 'type') {
      value = String(value || 'library').toLowerCase();
    } else if (LINK_FIELDS.includes(field) && value !== null && typeof value === 'object') {
      value = Object.fromEntries(Object.entries(value).map(([name, constraint]) => [name.toLowerCase(), constraint]));
    }
    if (!isEmptyValue(value)) {
      selected[field] = value;
    }
  }
  return crypto.createHash('sha256').update(canonicalJson(selected)).digest('hex');
}

function trailingSlash(url) {
  return url.endsWith('/') ? url : url + '/';
}

function metadataEntries(data, packageName, repoUrl) {
  if (data.minified) {
    throw new Error(`Minified metadata is not supported (${packageName})`);
  }
  const versions = (data.packages || {})[packageName] || [];
  const prefix = trailingSlash(repoUrl) + 'packages/';
  return (Array.isArray(versions) ? versions : Object.values(versions)).map(version => {
    if (!version.dist) {
      throw new Error(`${packageName} ${version.version}: no dist, the metadata is a seed satis did not replace`);
    }
    const url = version.dist.url || '';
    if (!url.startsWith(prefix)) {
      throw new Error(`${packageName} ${version.version}: dist url "${url}" is not below ${prefix}`);
    }
    return {
      name: version.name,
      version: version.version,
      version_normalized: version.version_normalized,
      path: url.slice(prefix.length),
      shasum: version.dist.shasum || '',
      publishedTime: version['published-time'] || '',
      metadataSha256: metadataSha256(version),
      ...(version.replace ? {replace: version.replace} : {}),
    };
  });
}

/**
 * Read every package version from the p2 metadata satis generated. Those are the files composer 2
 * resolves from, and the only ones it reads published-time from.
 */
function readSatisOutput(satisOutputDir, repoUrl) {
  const packages = JSON.parse(fs.readFileSync(path.join(satisOutputDir, 'packages.json'), 'utf8'));
  if (!Array.isArray(packages['available-packages'])) {
    throw new Error('packages.json has no available-packages list');
  }
  const entries = [];
  for (const name of packages['available-packages']) {
    const files = [`${name}.json`, `${name}~dev.json`]
      .map(file => path.join(satisOutputDir, 'p2', file))
      .filter(file => fs.existsSync(file));
    if (files.length === 0) {
      throw new Error(`No p2 metadata found for ${name}`);
    }
    for (const file of files) {
      entries.push(...metadataEntries(JSON.parse(fs.readFileSync(file, 'utf8')), name, repoUrl));
    }
  }
  return entries;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha1 = crypto.createHash('sha1');
    const sha256 = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', chunk => {
        sha1.update(chunk);
        sha256.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve({sha1: sha1.digest('hex'), sha256: sha256.digest('hex')}));
  });
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

async function hashBuiltEntries(entries, packagesDir, incremental) {
  return mapConcurrent(entries, 8, async entry => {
    const file = path.join(packagesDir, entry.path);
    if (incremental && !fs.existsSync(file)) {
      return {...entry, sha1: entry.shasum, sha256: '', built: false};
    }
    return {...entry, ...(await hashFile(file))};
  });
}

/**
 * The package a magento/* alias metapackage points at, or null if the archive is anything other
 * than a composer.json-only metapackage requiring exactly one package.
 */
async function readAliasTarget(zipFile) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipFile));
  const files = Object.values(zip.files).filter(file => !file.dir);
  if (files.length !== 1 || files[0].name !== 'composer.json') {
    return null;
  }
  try {
    return aliasTarget(JSON.parse(await files[0].async('string')));
  } catch (exception) {
    return null;
  }
}

/**
 * Classify the packages satis was run over against the ledger.
 *
 * With allowAliasRepoint, a changed magento/* alias metapackage is accepted if all it does is
 * require the highest mage-os/* version replacing it in this build, which is the version the
 * release build points the alias at. Every release legitimately changes the aliases it supersedes.
 *
 * With incremental, versions without an archive in packagesDir are checked by their metadata only, and
 * fail unless they are unchanged published versions.
 */
async function verifyBuild(rows, {satisOutputDir, packagesDir, repoUrl, expectDiff = [], allowAliasRepoint = false, incremental = false, now = new Date()}) {
  const entries = await hashBuiltEntries(readSatisOutput(satisOutputDir, repoUrl), packagesDir, incremental);
  const results = notBuiltProblems(classify(rows, entries, {expectDiff, now}));
  if (!allowAliasRepoint) {
    return results;
  }
  const aliasTargets = new Map();
  for (const {status, entry} of results) {
    if (status === STATUS.MODIFIED && entry.built !== false) {
      const alias = await readAliasTarget(path.join(packagesDir, entry.path));
      alias && aliasTargets.set(rowKey(entry), alias);
    }
  }
  if (aliasTargets.size === 0) {
    return results;
  }
  const composers = await mapConcurrent(
    entries.filter(entry => entry.path.startsWith('mage-os/')),
    8,
    entry => entry.built === false ? entry : readComposerJsonFromZip(path.join(packagesDir, entry.path))
  );
  return notBuiltProblems(classify(rows, entries, {expectDiff, aliasTargets, replacers: newestReplacers(composers), now}));
}

function notBuiltProblems(results) {
  for (const {status, problems, entry} of results) {
    if (entry && entry.built === false && status !== STATUS.UNCHANGED) {
      problems.push(`${status} version has no archive in the build`);
    }
  }
  return results;
}

/**
 * Every package version in the include files of the packages.json in a satis output dir.
 */
function readIncludedVersions(satisOutputDir) {
  const packages = JSON.parse(fs.readFileSync(path.join(satisOutputDir, 'packages.json'), 'utf8'));
  return Object.keys(packages.includes || {}).flatMap(include => {
    const data = JSON.parse(fs.readFileSync(path.join(satisOutputDir, include), 'utf8'));
    return Object.values(data.packages || {}).flatMap(versions => Object.values(versions));
  });
}

/**
 * Fetch the packages.json and include files a live repository serves, to base an incremental build on.
 * Check them with baseMetadataFailures() before using them.
 *
 * @param {String} baseUrl Where to fetch from, normally the repository URL
 * @param {function(String): Promise<String>} fetchText
 * @returns {Promise<Array<{file: String, text: String}>>} packages.json first
 */
async function fetchBaseMetadata(baseUrl, fetchText) {
  const base = trailingSlash(baseUrl);
  // Without the query, a CDN may serve a packages.json naming an include file that is no longer the current one
  const noCache = `?nocache=${Date.now()}`;
  const packagesText = await fetchText(base + 'packages.json' + noCache);
  const files = [{file: 'packages.json', text: packagesText}];
  for (const include of Object.keys(JSON.parse(packagesText).includes || {})) {
    if (include.split('/').includes('..') || path.isAbsolute(include)) {
      throw new Error(`Include file outside of the repository: ${include}`);
    }
    files.push({file: include, text: await fetchText(base + include + noCache)});
  }
  return files;
}

/**
 * Reasons fetched base metadata can not be used: unless every ledger version is in it, as recorded,
 * and nothing else, satis would publish a version differently or drop it.
 *
 * @param {Array<Object>} rows Ledger rows
 * @param {Array<{file: String, text: String}>} files Result of fetchBaseMetadata()
 * @param {String} repoUrl The repository URL the dist urls are below
 */
function baseMetadataFailures(rows, files, repoUrl) {
  const entries = [];
  for (const {text} of files.slice(1)) {
    const data = JSON.parse(text);
    for (const name of Object.keys(data.packages || {})) {
      entries.push(...metadataEntries(data, name, repoUrl).map(({shasum, ...entry}) => ({...entry, sha1: shasum})));
    }
  }
  const results = classify(rows, entries);
  const failures = gateFailures(results);
  const {new: unknown} = summarize(results);
  if (unknown > 0) {
    failures.push(`${unknown} version(s) that are not in the ledger`);
  }
  return {results, failures};
}

function writeBaseMetadata(files, satisOutputDir) {
  if (fs.existsSync(path.join(satisOutputDir, 'packages.json'))) {
    throw new Error(`Refusing to write the base metadata: ${satisOutputDir}/packages.json already exists`);
  }
  for (const {file, text} of files) {
    const target = path.join(satisOutputDir, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, text);
  }
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

function publishedTimeProblem(entry, row, now) {
  if (row) {
    return entry.publishedTime === row['published-time']
      ? null
      : `published-time is "${entry.publishedTime}", the ledger has "${row['published-time']}"`;
  }
  if (!TIME_PATTERN.test(entry.publishedTime) || Number.isNaN(Date.parse(entry.publishedTime))) {
    return `new version has no valid published-time ("${entry.publishedTime}")`;
  }
  const age = now.getTime() - Date.parse(entry.publishedTime);
  if (age < -CLOCK_SKEW_MS) {
    return `new version has a published-time in the future (${entry.publishedTime})`;
  }
  if (age > NEW_VERSION_MAX_AGE_MS) {
    return `new version has a backdated published-time (${entry.publishedTime})`;
  }
  return null;
}

/**
 * Compare package versions (from a build, or from a live repository) against the ledger.
 *
 * Entries without a sha256 are compared on sha1 only, and entries without a shasum/publishedTime/metadataSha256
 * property skip the respective check, which is how a metadata-only audit uses this.
 *
 * @param {Array<Object>} rows Ledger rows
 * @param {Array<Object>} entries {name, version, version_normalized, path, sha1, [sha256], [shasum], [publishedTime], [metadataSha256]}
 * @param {{expectDiff: Array<String>, aliasTargets: Map<String, Object>, replacers: Map<String, Object>, now: Date}} options
 *   aliasTargets maps the rowKey of a changed alias metapackage to what readAliasTarget() returned for it,
 *   replacers is what newestReplacers() returned for the mage-os/* packages of the build
 * @returns {Array<{status: String, problems: Array<String>, row: Object|null, entry: Object|null}>}
 */
function classify(rows, entries, {expectDiff = [], aliasTargets = new Map(), replacers = new Map(), now = new Date()} = {}) {
  const ledger = new Map(rows.map(row => [rowKey(row), row]));
  const expected = expectDiff.map(globToRegExp);
  const seen = new Set();

  for (const entry of entries) {
    const key = rowKey(entry);
    if (seen.has(key)) {
      throw new Error(`Duplicate package version ${key}`);
    }
    seen.add(key);
  }

  const isAliasRepoint = entry => {
    const alias = aliasTargets.get(rowKey(entry));
    const replacer = alias && replacers.get(`${alias.name}:${alias.version}`);
    return Boolean(replacer)
      && alias.name === entry.name
      && alias.version === entry.version
      && alias.target.name === replacer.mageOsName
      && alias.target.version === replacer.mageOsVersion;
  };

  const results = entries.map(entry => {
    const row = ledger.get(rowKey(entry)) || null;
    const problems = [];

    if (entry.shasum !== undefined && entry.shasum !== entry.sha1) {
      problems.push(`metadata shasum ${entry.shasum} does not match the archive (${entry.sha1})`);
    }
    if (entry.publishedTime !== undefined) {
      const problem = publishedTimeProblem(entry, row, now);
      problem && problems.push(problem);
    }

    let status;
    if (!row) {
      status = STATUS.NEW;
    } else if (
      row.sha1 === entry.sha1
      && row.path === entry.path
      && row.version === entry.version
      && (!row.sha256 || !entry.sha256 || row.sha256 === entry.sha256)
    ) {
      status = STATUS.UNCHANGED;
    } else if (expected.some(pattern => pattern.test(entry.path))) {
      status = STATUS.EXPECTED;
    } else if (isAliasRepoint(entry)) {
      status = STATUS.REPOINTED;
    } else {
      status = STATUS.MODIFIED;
    }
    if (status === STATUS.UNCHANGED && entry.metadataSha256 !== undefined && entry.metadataSha256 !== row['metadata-sha256']) {
      problems.push(`metadata-sha256 ${entry.metadataSha256} does not match the ledger (${row['metadata-sha256']})`);
    }
    return {status, problems, row, entry};
  });

  for (const row of rows) {
    if (!seen.has(rowKey(row))) {
      results.push({status: STATUS.MISSING, problems: [], row, entry: null});
    }
  }
  return results;
}

/**
 * Reasons the classified build must not be deployed.
 */
function gateFailures(results) {
  const failures = [];
  const count = status => results.filter(result => result.status === status).length;
  const problems = results.filter(result => result.problems.length > 0).length;

  if (problems > 0) {
    failures.push(`${problems} version(s) with a published-time or shasum problem`);
  }
  if (count(STATUS.MODIFIED) > 0) {
    failures.push(`${count(STATUS.MODIFIED)} already published version(s) modified`);
  }
  if (count(STATUS.MISSING) > 0) {
    failures.push(`${count(STATUS.MISSING)} already published version(s) missing from the build`);
  }
  return failures;
}

/**
 * The ledger after the classified build is deployed. Only call this for a build that passed the gate.
 */
function nextRows(results) {
  const rows = [];
  for (const {status, row, entry} of results) {
    switch (status) {
      case STATUS.UNCHANGED:
        rows.push({...row, sha256: row.sha256 || entry.sha256});
        break;
      case STATUS.NEW:
        rows.push({
          name: entry.name,
          version: entry.version,
          version_normalized: entry.version_normalized,
          path: entry.path,
          sha1: entry.sha1,
          sha256: entry.sha256,
          'metadata-sha256': entry.metadataSha256,
          'published-time': entry.publishedTime,
          source: 'build',
        });
        break;
      case STATUS.REPOINTED:
        rows.push({
          ...row,
          version: entry.version,
          path: entry.path,
          sha1: entry.sha1,
          sha256: entry.sha256,
          'metadata-sha256': entry.metadataSha256,
        });
        break;
      case STATUS.EXPECTED:
        rows.push(row);
        break;
      default:
        throw new Error(`A build with ${status} versions can not be recorded`);
    }
  }
  return rows;
}

/**
 * Reasons a deploy must not start, checked before anything is built.
 *
 * @param {Array<Object>} rows Ledger rows
 * @param {{target: String, mageosRelease: String, publishTag: Boolean}} options target is "production" or "preview"
 */
function guardFailures(rows, {target, mageosRelease = '', publishTag = false}) {
  const failures = [];
  if (target === 'production' && mageosRelease && !publishTag) {
    failures.push(`A production deploy of release ${mageosRelease} has to publish the release tag`);
  }
  if (target === 'preview' && publishTag) {
    failures.push('A preview deploy can not publish a release tag');
  }
  if (mageosRelease && rows.some(row => row.name === RELEASE_PACKAGE && row.version === mageosRelease)) {
    failures.push(`Release ${mageosRelease} is already published: ${RELEASE_PACKAGE} ${mageosRelease} is in the ledger`);
  }
  return failures;
}

function summarize(results) {
  const counts = Object.fromEntries(Object.values(STATUS).map(status => [status, 0]));
  let problems = 0;
  for (const result of results) {
    counts[result.status]++;
    problems += result.problems.length > 0 ? 1 : 0;
  }
  return {...counts, problems};
}

function formatReport(results, {title, markdown = false, limit = Infinity} = {}) {
  const summary = summarize(results);
  const lines = [];
  const heading = text => lines.push(markdown ? `### ${text}` : text, '');
  const table = (header, tableRows) => {
    if (markdown) {
      lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
    }
    for (const cells of tableRows.slice(0, limit)) {
      lines.push(markdown ? `| ${cells.join(' | ')} |` : `  ${cells.join('  ')}`);
    }
    if (tableRows.length > limit) {
      lines.push('', `… and ${tableRows.length - limit} more`);
    }
    lines.push('');
  };

  heading(title);
  table(['status', 'versions'], Object.entries(summary).map(([status, count]) => [status, String(count)]));

  const withProblems = results.filter(result => result.problems.length > 0);
  if (withProblems.length > 0) {
    heading('Problems');
    table(['package', 'version', 'problem'], withProblems.flatMap(({entry, problems}) =>
      problems.map(problem => [entry.name, entry.version, problem])
    ));
  }

  for (const status of [STATUS.MODIFIED, STATUS.MISSING, STATUS.REPOINTED, STATUS.EXPECTED, STATUS.NEW]) {
    const matching = results.filter(result => result.status === status);
    if (matching.length === 0) {
      continue;
    }
    heading(status);
    table(['package', 'version', 'ledger sha1', 'sha1'], matching.map(({row, entry}) => [
      (entry || row).name,
      (entry || row).version,
      row ? row.sha1 : '',
      entry ? entry.sha1 : '',
    ]));
  }
  return lines.join('\n');
}

/**
 * Load every package version a composer repository serves, from its include files, or with
 * fromMetadataUrl from the p2 files composer 2 reads (one request per package).
 *
 * @param {String} repoUrl
 * @param {function(String): Promise<Object>} fetchJson
 */
async function fetchRepoEntries(repoUrl, fetchJson, {fromMetadataUrl = false} = {}) {
  const base = trailingSlash(repoUrl);
  const packages = await fetchJson(base + 'packages.json');
  const toEntries = (data, name) => metadataEntries(data, name, base).map(({shasum, publishedTime, ...entry}) => ({
    ...entry,
    sha1: shasum,
    ...(fromMetadataUrl ? {publishedTime} : {}),
  }));

  if (!fromMetadataUrl) {
    const entries = [];
    for (const include of Object.keys(packages.includes || {})) {
      const data = await fetchJson(base + include);
      for (const name of Object.keys(data.packages || {})) {
        entries.push(...toEntries(data, name));
      }
    }
    return entries;
  }

  const names = packages['available-packages'] || [];
  const perPackage = await mapConcurrent(names, 8, async name => {
    const entries = toEntries(await fetchJson(`${base}p2/${name}.json`), name);
    try {
      entries.push(...toEntries(await fetchJson(`${base}p2/${name}~dev.json`), name));
    } catch (exception) {
      if (exception.status !== 404) {
        throw exception;
      }
    }
    return entries;
  });
  return perPackage.flat();
}

/**
 * Build the initial ledger rows for a repository that is already live.
 *
 * @param {Array<Object>} entries Result of fetchRepoEntries()
 * @param {Map<String, {time: String, source: String}>} times Keyed by "name version"
 * @param {{defaultTime: String|null, now: Date}} options
 */
function bootstrapRows(entries, times, {defaultTime = null, now = new Date()} = {}) {
  const isUsable = time => !Number.isNaN(Date.parse(time)) && Date.parse(time) <= now.getTime();
  if (defaultTime && !isUsable(defaultTime)) {
    throw new Error(`The default published-time "${defaultTime}" is no date or in the future`);
  }
  return entries.map(entry => {
    const known = times.get(`${entry.name} ${entry.version}`);
    const usable = known && isUsable(known.time);
    if (!usable && !defaultTime) {
      throw new Error(`No usable published-time for ${entry.name} ${entry.version} and no default given`);
    }
    return {
      name: entry.name,
      version: entry.version,
      version_normalized: entry.version_normalized,
      path: entry.path,
      sha1: entry.sha1,
      sha256: '',
      'metadata-sha256': entry.metadataSha256,
      'published-time': formatTime(new Date(usable ? known.time : defaultTime)),
      source: usable ? known.source : 'bootstrap',
    };
  });
}

function parseTimes(text) {
  const times = new Map();
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const [name, version, time, source] = line.split('\t');
    times.set(`${name} ${version}`, {time, source});
  }
  return times;
}

module.exports = {
  FIELDS,
  STATUS,
  baseMetadataFailures,
  bootstrapRows,
  buildSeeds,
  classify,
  fetchBaseMetadata,
  fetchRepoEntries,
  formatLedger,
  formatReport,
  formatTime,
  gateFailures,
  guardFailures,
  metadataSha256,
  nextRows,
  parseLedger,
  parseTimes,
  readAliasTarget,
  readIncludedVersions,
  readLedger,
  readSatisOutput,
  rowKey,
  summarize,
  verifyBuild,
  writeBaseMetadata,
  writeLedger,
  writeSeeds,
};
