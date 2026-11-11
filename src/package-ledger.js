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

const FIELDS = ['name', 'version', 'version_normalized', 'path', 'sha1', 'sha256', 'published-time', 'source'];
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
    const url = (version.dist || {}).url || '';
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

async function hashBuiltEntries(entries, packagesDir) {
  return mapConcurrent(entries, 8, async entry => ({
    ...entry,
    ...(await hashFile(path.join(packagesDir, entry.path))),
  }));
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
  let composer;
  try {
    composer = JSON.parse(await files[0].async('string'));
  } catch (exception) {
    return null;
  }
  const allowedKeys = ['name', 'description', 'type', 'version', 'require'];
  if (!composer || typeof composer !== 'object' || Object.keys(composer).some(key => !allowedKeys.includes(key))) {
    return null;
  }
  const requires = Object.entries(composer.require || {});
  if (
    typeof composer.name !== 'string'
    || !composer.name.startsWith('magento/')
    || composer.type !== 'metapackage'
    || requires.length !== 1
    || typeof requires[0][1] !== 'string'
  ) {
    return null;
  }
  return {
    name: composer.name,
    version: composer.version,
    target: {name: requires[0][0], version: requires[0][1]},
  };
}

/**
 * Classify the packages satis was run over against the ledger.
 *
 * With allowAliasRepoint, a changed magento/* alias metapackage is accepted if all it does is
 * require a package version that is itself new in this build. Aliases point at the highest
 * version replacing them, so every release legitimately changes the aliases it supersedes.
 */
async function verifyBuild(rows, {satisOutputDir, packagesDir, repoUrl, expectDiff = [], allowAliasRepoint = false, now = new Date()}) {
  const entries = await hashBuiltEntries(readSatisOutput(satisOutputDir, repoUrl), packagesDir);
  const results = classify(rows, entries, {expectDiff, now});
  if (!allowAliasRepoint) {
    return results;
  }
  const aliasTargets = new Map();
  for (const {status, entry} of results) {
    if (status === STATUS.MODIFIED) {
      const alias = await readAliasTarget(path.join(packagesDir, entry.path));
      alias && aliasTargets.set(rowKey(entry), alias);
    }
  }
  return classify(rows, entries, {expectDiff, aliasTargets, now});
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
 * Entries without a sha256 are compared on sha1 only, and entries without a shasum/publishedTime
 * property skip the respective check, which is how a metadata-only audit uses this.
 *
 * @param {Array<Object>} rows Ledger rows
 * @param {Array<Object>} entries {name, version, version_normalized, path, sha1, [sha256], [shasum], [publishedTime]}
 * @param {{expectDiff: Array<String>, aliasTargets: Map<String, Object>, now: Date}} options
 *   aliasTargets maps the rowKey of a changed alias metapackage to what readAliasTarget() returned for it
 * @returns {Array<{status: String, problems: Array<String>, row: Object|null, entry: Object|null}>}
 */
function classify(rows, entries, {expectDiff = [], aliasTargets = new Map(), now = new Date()} = {}) {
  const ledger = new Map(rows.map(row => [rowKey(row), row]));
  const expected = expectDiff.map(globToRegExp);
  const seen = new Set();
  const newVersions = new Set();

  for (const entry of entries) {
    const key = rowKey(entry);
    if (seen.has(key)) {
      throw new Error(`Duplicate package version ${key}`);
    }
    seen.add(key);
    if (!ledger.has(key)) {
      newVersions.add(`${entry.name} ${entry.version}`);
    }
  }

  const isAliasRepoint = entry => {
    const alias = aliasTargets.get(rowKey(entry));
    return Boolean(alias)
      && alias.name === entry.name
      && alias.version === entry.version
      && newVersions.has(`${alias.target.name} ${alias.target.version}`);
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
 * Reasons the classified build must not be deployed. A published-time or shasum problem can not be
 * waved through: allowChanges only covers changed and missing archives.
 */
function gateFailures(results, {allowChanges = false} = {}) {
  const failures = [];
  const count = status => results.filter(result => result.status === status).length;
  const problems = results.filter(result => result.problems.length > 0).length;

  if (problems > 0) {
    failures.push(`${problems} version(s) with a published-time or shasum problem`);
  }
  if (!allowChanges && count(STATUS.MODIFIED) > 0) {
    failures.push(`${count(STATUS.MODIFIED)} already published version(s) modified`);
  }
  if (!allowChanges && count(STATUS.MISSING) > 0) {
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
          'published-time': entry.publishedTime,
          source: 'build',
        });
        break;
      case STATUS.REPOINTED:
      case STATUS.MODIFIED:
        rows.push({...row, version: entry.version, path: entry.path, sha1: entry.sha1, sha256: entry.sha256});
        break;
      case STATUS.EXPECTED:
        rows.push(row);
        break;
    }
  }
  return rows;
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
  bootstrapRows,
  buildSeeds,
  classify,
  fetchRepoEntries,
  formatLedger,
  formatReport,
  formatTime,
  gateFailures,
  nextRows,
  parseLedger,
  parseTimes,
  readAliasTarget,
  readLedger,
  readSatisOutput,
  rowKey,
  summarize,
  verifyBuild,
  writeLedger,
  writeSeeds,
};
