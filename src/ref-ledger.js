/**
 * Ref ledger: the git tags a deploy built its packages from, next to the package ledger.
 *
 * One line per build instruction and tag, with the commit the tag pointed at and a fingerprint of the
 * instruction's configuration. A later build skips a recorded tag as long as both are unchanged, so it
 * reads nothing from git for it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {tsvLedger} = require('./tsv-ledger');

const FIELDS = ['instruction', 'tag', 'commit', 'fingerprint'];

// createPackageForRef adds these to the excludes of every package it builds
const IMPLIED_EXCLUDES = ['composer.json', '.git/'];

const ROOT = path.resolve(__dirname, '..');

/**
 * Whether building the same commit again would fail the same way: the generator rejecting what it read
 * (it throws plain objects for that), or a file the tag does not have. Anything else, a failing git
 * command say, may not happen on the next run, so the tag is built again then.
 */
function isRepeatableFailure(exception) {
  return exception !== null
    && typeof exception === 'object'
    && (!(exception instanceof Error) || exception.code === 'ENOENT');
}

function refKey({instruction, tag}) {
  return `${instruction} ${tag}`;
}

function publishedKey(name, version) {
  return `${name} ${version}`;
}

function compareRefs(a, b) {
  const ka = refKey(a);
  const kb = refKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function validateRef(row, context) {
  for (const field of FIELDS) {
    if (typeof row[field] !== 'string' || /[\t\n\r]/.test(row[field])) {
      throw new Error(`${context}: invalid ${field}`);
    }
  }
  if (!row.instruction || !row.tag) {
    throw new Error(`${context}: instruction and tag are required`);
  }
  if (!/^[0-9a-f]{40}$/.test(row.commit)) {
    throw new Error(`${context}: invalid commit`);
  }
  if (!/^[0-9a-f]{64}$/.test(row.fingerprint)) {
    throw new Error(`${context}: invalid fingerprint`);
  }
}

const {parse: parseRefs, format: formatRefs, read: readRefs, write: writeRefs} = tsvLedger({
  fields: FIELDS,
  key: refKey,
  compare: compareRefs,
  validate: validateRef,
  label: 'Ref ledger',
});

/**
 * Hash of everything in a build instruction that decides which packages its tags produce, functions by
 * their source. The ref is left out: it is the branch a new release is built from, not used for tags.
 */
function instructionFingerprint(instruction, composerRepoUrl) {
  const {ref, ...config} = instruction;
  const json = JSON.stringify({composerRepoUrl, config}, (key, value) => {
    if (typeof value === 'function') {
      return value.toString();
    }
    if (key === 'composerJsonFile') {
      return undefined;
    }
    if (key === 'excludes' && Array.isArray(value)) {
      return value.filter(exclude => !IMPLIED_EXCLUDES.includes(exclude));
    }
    // The build config refers to files of this repository by absolute path, which depends on the checkout
    if (typeof value === 'string' && path.isAbsolute(value) && path.resolve(value).startsWith(ROOT + path.sep)) {
      return path.relative(ROOT, value);
    }
    return value;
  });
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Add the tags a build processed to the ref ledger, once every version they produced is in the
 * package ledger.
 *
 * @param {Array<Object>} rows Ref ledger rows
 * @param {Array<{instruction: String, tag: String, commit: String, fingerprint: String, versions: Array<Array<String>>}>} pending
 * @param {Array<Object>} ledgerRows Package ledger rows
 * @returns {{rows: Array<Object>, recorded: Number, notPublished: Array<String>}}
 */
function mergeRefs(rows, pending, ledgerRows) {
  const published = new Set(ledgerRows.map(row => publishedKey(row.name, row.version)));
  const merged = new Map(rows.map(row => [refKey(row), row]));
  const notPublished = [];
  let recorded = 0;
  for (const {instruction, tag, commit, fingerprint, versions} of pending) {
    const row = {instruction, tag, commit, fingerprint};
    const previous = merged.get(refKey(row));
    if (previous && previous.commit !== commit) {
      throw new Error(`Tag ${tag} of ${instruction} was recorded at ${previous.commit} and now points at ${commit}`);
    }
    if (!versions.every(([name, version]) => published.has(publishedKey(name, version)))) {
      notPublished.push(refKey(row));
      continue;
    }
    validateRef(row, `Built ref ${refKey(row)}`);
    merged.set(refKey(row), row);
    recorded++;
  }
  return {rows: [...merged.values()], recorded, notPublished};
}

/**
 * Tracks the tags of one build run: which recorded tags to skip, and what the processed ones produced.
 *
 * @param {{rows: Array<Object>, skip: Boolean, listRemoteTags: function(String): Promise<Map<String, String>>, pendingFile: String|null}} options
 */
function createRefRecorder({rows = [], skip = false, listRemoteTags, pendingFile = null}) {
  const pending = [];
  const remotes = new Map();

  /**
   * Start listing the tags of the repositories the build will process, a few at a time. A failure
   * surfaces when forInstruction() awaits the listing.
   *
   * @param {Array<String>} urls
   */
  function prefetch(urls, concurrency = 8) {
    const lanes = Array.from({length: concurrency}, () => Promise.resolve());
    [...new Set(urls)].filter(url => !remotes.has(url)).forEach((url, index) => {
      const lane = index % concurrency;
      const listing = lanes[lane].then(() => listRemoteTags(url));
      lanes[lane] = listing.catch(() => {});
      remotes.set(url, listing);
    });
  }

  function remoteTagsOf(url) {
    prefetch([url]);
    return remotes.get(url);
  }

  async function forInstruction(instruction, composerRepoUrl) {
    const key = instruction.key;
    const fingerprint = instructionFingerprint(instruction, composerRepoUrl);
    const remote = await remoteTagsOf(instruction.repoUrl);
    const extraCommits = new Map(instruction.extraRefToRelease.map(extra => [extra.release, extra.ref]));
    const commitOf = tag => extraCommits.has(tag) ? extraCommits.get(tag) : remote.get(tag);

    const trusted = new Set();
    for (const row of rows.filter(row => row.instruction === key)) {
      const commit = commitOf(row.tag);
      if (commit === undefined) {
        throw new Error(`Recorded tag ${row.tag} of ${key} no longer exists on ${instruction.repoUrl}`);
      }
      if (commit !== row.commit) {
        throw new Error(`Recorded tag ${row.tag} of ${key} moved from ${row.commit} to ${commit}`);
      }
      if (skip && row.fingerprint === fingerprint) {
        trusted.add(row.tag);
      }
    }
    if (skip && trusted.size === 0 && rows.some(row => row.instruction === key)) {
      console.log(`The configuration of ${key} changed since its tags were recorded, rebuilding all of them`);
    }

    const results = new Map();
    const resultOf = tag => {
      if (!results.has(tag)) {
        results.set(tag, {failed: false, versions: new Map()});
      }
      return results.get(tag);
    };

    return {
      remoteTags: () => [...remote.keys()],
      isRecorded: tag => trusted.has(tag),
      built(tag, packages) {
        const {versions} = resultOf(tag);
        Object.entries(packages || {}).forEach(([name, version]) => versions.set(`${name} ${version}`, [name, version]));
      },
      failed(tag, exception) {
        const result = resultOf(tag);
        result.failed = result.failed || !isRepeatableFailure(exception);
      },
      done() {
        for (const [tag, {failed, versions}] of results) {
          const commit = commitOf(tag);
          if (failed || !/^[0-9a-f]{40}$/.test(commit || '')) {
            continue;
          }
          pending.push({instruction: key, tag, commit, fingerprint, versions: [...versions.values()]});
        }
        if (pendingFile) {
          fs.mkdirSync(path.dirname(pendingFile), {recursive: true});
          fs.writeFileSync(pendingFile, JSON.stringify(pending));
        }
      },
    };
  }

  return {forInstruction, prefetch};
}

module.exports = {
  FIELDS,
  createRefRecorder,
  formatRefs,
  instructionFingerprint,
  isRepeatableFailure,
  mergeRefs,
  publishedKey,
  parseRefs,
  readRefs,
  writeRefs,
};
