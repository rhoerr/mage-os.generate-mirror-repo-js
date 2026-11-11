'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const sut = require('../../src/package-ledger');

const {STATUS} = sut;
const NOW = new Date('2026-11-11T12:00:00Z');
const REPO_URL = 'https://repo.example.com/';

const sha1 = content => crypto.createHash('sha1').update(content).digest('hex');
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');

function row(overrides = {}) {
  const name = overrides.name || 'acme/alpha';
  const version = overrides.version || '1.0.0';
  return {
    name,
    version,
    version_normalized: `${version}.0`,
    path: `${name}-${version}.zip`,
    sha1: sha1(`${name} ${version}`),
    sha256: '',
    'published-time': '2024-05-01T10:00:00+00:00',
    source: 'tag',
    ...overrides,
  };
}

function entryFor(ledgerRow, overrides = {}) {
  return {
    name: ledgerRow.name,
    version: ledgerRow.version,
    version_normalized: ledgerRow.version_normalized,
    path: ledgerRow.path,
    sha1: ledgerRow.sha1,
    sha256: sha256(`${ledgerRow.name} ${ledgerRow.version}`),
    shasum: ledgerRow.sha1,
    publishedTime: ledgerRow['published-time'],
    ...overrides,
  };
}

function newEntry(overrides = {}) {
  const base = row(overrides);
  return entryFor(base, {publishedTime: '2026-11-11T11:55:00+00:00', ...overrides});
}

const statusOf = (results, name, version) => results
  .find(result => (result.entry || result.row).name === name && (result.entry || result.row).version === version)
  .status;

describe('package-ledger', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-ledger-'));
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  describe('ledger file format', () => {
    it('round-trips rows through the text format', () => {
      const rows = [row(), row({version: '1.1.0', sha256: sha256('x'), source: 'build'})];
      expect(sut.parseLedger(sut.formatLedger(rows))).toEqual(rows);
    });

    it('starts with a header line and ends with a newline', () => {
      const text = sut.formatLedger([row()]);
      expect(text.split('\n')[0]).toBe(sut.FIELDS.join('\t'));
      expect(text.endsWith('\n')).toBe(true);
    });

    it('sorts by package name, then numerically by version', () => {
      const rows = [
        row({name: 'acme/beta', version: '1.0.0'}),
        row({name: 'acme/alpha', version: '1.0.10'}),
        row({name: 'acme/alpha', version: '1.0.9'}),
        row({name: 'acme/alpha', version: '1.0.9-p1', version_normalized: '1.0.9.0-patch1'}),
        row({name: 'acme/alpha', version: 'dev-main', version_normalized: 'dev-main'}),
      ];
      const sorted = sut.parseLedger(sut.formatLedger(rows)).map(r => `${r.name} ${r.version}`);
      expect(sorted).toEqual([
        'acme/alpha 1.0.9',
        'acme/alpha 1.0.9-p1',
        'acme/alpha 1.0.10',
        'acme/alpha dev-main',
        'acme/beta 1.0.0',
      ]);
    });

    it('produces the same text regardless of the input order', () => {
      const rows = [row(), row({version: '2.0.0'}), row({name: 'acme/beta'})];
      expect(sut.formatLedger(rows.slice().reverse())).toBe(sut.formatLedger(rows));
    });

    it.each([
      ['sha1', {sha1: 'abc'}],
      ['sha256', {sha256: 'abc'}],
      ['published-time without UTC offset', {'published-time': '2024-05-01T10:00:00-05:00'}],
      ['published-time that is no date', {'published-time': '2024-13-41T10:00:00+00:00'}],
      ['source', {source: 'guess'}],
      ['empty path', {path: ''}],
      ['tab in a value', {path: 'a\tb'}],
    ])('rejects an invalid %s', (_, overrides) => {
      expect(() => sut.formatLedger([row(overrides)])).toThrow();
    });

    it('rejects duplicate versions', () => {
      expect(() => sut.formatLedger([row(), row({sha1: sha1('other')})])).toThrow(/duplicate/);
    });

    it('rejects a file with a wrong header or field count', () => {
      const text = sut.formatLedger([row()]);
      expect(() => sut.parseLedger(text.replace('name\t', 'package\t'))).toThrow(/header/);
      expect(() => sut.parseLedger(text + 'acme/alpha\t1.0.0\n')).toThrow(/expected 8 fields/);
    });

    it('writes and reads a ledger file, creating the directory', () => {
      const file = path.join(dir, 'ledger', 'test.tsv');
      sut.writeLedger(file, [row()]);
      expect(sut.readLedger(file)).toEqual([row()]);
    });
  });

  describe('seeds', () => {
    it('lists every ledger version with version_normalized and published-time', () => {
      const seeds = sut.buildSeeds([
        row(),
        row({version: '1.1.0', 'published-time': '2025-01-01T00:00:00+00:00'}),
        row({name: 'acme/beta'}),
      ]);
      expect(seeds).toEqual({
        'p2/acme/alpha.json': {packages: {'acme/alpha': [
          {version: '1.0.0', version_normalized: '1.0.0.0', 'published-time': '2024-05-01T10:00:00+00:00'},
          {version: '1.1.0', version_normalized: '1.1.0.0', 'published-time': '2025-01-01T00:00:00+00:00'},
        ]}},
        'p2/acme/beta.json': {packages: {'acme/beta': [
          {version: '1.0.0', version_normalized: '1.0.0.0', 'published-time': '2024-05-01T10:00:00+00:00'},
        ]}},
      });
    });

    it('puts dev versions into the ~dev metadata file', () => {
      const seeds = sut.buildSeeds([
        row({version: '1.1-dev', version_normalized: '1.1.0.0-dev'}),
        row({version: 'dev-main', version_normalized: 'dev-main'}),
      ]);
      expect(Object.keys(seeds)).toEqual(['p2/acme/alpha~dev.json']);
      expect(seeds['p2/acme/alpha~dev.json'].packages['acme/alpha']).toHaveLength(2);
    });

    it('writes the seed files into the satis output dir', () => {
      expect(sut.writeSeeds([row(), row({name: 'acme/beta'})], dir)).toBe(2);
      const seed = JSON.parse(fs.readFileSync(path.join(dir, 'p2/acme/alpha.json'), 'utf8'));
      expect(seed.packages['acme/alpha'][0]['published-time']).toBe('2024-05-01T10:00:00+00:00');
    });

    it('refuses to seed an output dir that already has metadata', () => {
      fs.mkdirSync(path.join(dir, 'p2'));
      expect(() => sut.writeSeeds([row()], dir)).toThrow(/already exists/);
    });
  });

  describe('classify', () => {
    it('reports a build matching the ledger as unchanged', () => {
      const rows = [row(), row({version: '1.1.0'})];
      const results = sut.classify(rows, rows.map(r => entryFor(r)), {now: NOW});
      expect(sut.summarize(results)).toEqual({
        unchanged: 2, new: 0, expected: 0, repointed: 0, modified: 0, missing: 0, problems: 0,
      });
    });

    it('reports versions that are not in the ledger as new', () => {
      const results = sut.classify([row()], [entryFor(row()), newEntry({version: '2.0.0'})], {now: NOW});
      expect(statusOf(results, 'acme/alpha', '2.0.0')).toBe(STATUS.NEW);
      expect(sut.gateFailures(results)).toEqual([]);
    });

    it('reports a different sha1 as modified', () => {
      const results = sut.classify([row()], [entryFor(row(), {sha1: sha1('changed'), shasum: sha1('changed')})], {now: NOW});
      expect(results[0].status).toBe(STATUS.MODIFIED);
    });

    it('reports a different sha256 as modified even if the sha1 matches', () => {
      const rows = [row({sha256: sha256('recorded')})];
      const results = sut.classify(rows, [entryFor(rows[0], {sha256: sha256('collision')})], {now: NOW});
      expect(results[0].status).toBe(STATUS.MODIFIED);
    });

    it('reports a different archive path as modified', () => {
      const results = sut.classify([row()], [entryFor(row(), {path: 'acme/other-1.0.0.zip'})], {now: NOW});
      expect(results[0].status).toBe(STATUS.MODIFIED);
    });

    it('reports ledger versions without a built counterpart as missing', () => {
      const results = sut.classify([row(), row({version: '1.1.0'})], [entryFor(row())], {now: NOW});
      expect(statusOf(results, 'acme/alpha', '1.1.0')).toBe(STATUS.MISSING);
    });

    it('reports a changed archive matching an expectDiff glob as expected', () => {
      const project = row({name: 'acme/project-community-edition'});
      const changed = {sha1: sha1('preview'), shasum: sha1('preview')};
      const results = sut.classify(
        [project, row()],
        [entryFor(project, changed), entryFor(row(), changed)],
        {expectDiff: ['*/project-community-edition-*'], now: NOW}
      );
      expect(statusOf(results, 'acme/project-community-edition', '1.0.0')).toBe(STATUS.EXPECTED);
      expect(statusOf(results, 'acme/alpha', '1.0.0')).toBe(STATUS.MODIFIED);
    });

    it('throws on a version listed twice', () => {
      expect(() => sut.classify([], [newEntry(), newEntry()], {now: NOW})).toThrow(/Duplicate/);
    });

    it('compares on sha1 only for entries without sha256, shasum and published-time', () => {
      const rows = [row({sha256: sha256('recorded')})];
      const {name, version, version_normalized, path: archivePath, sha1: hash} = rows[0];
      const results = sut.classify(rows, [{name, version, version_normalized, path: archivePath, sha1: hash}]);
      expect(results[0]).toMatchObject({status: STATUS.UNCHANGED, problems: []});
    });

    describe('published-time', () => {
      it('flags a ledger version whose published-time was re-stamped', () => {
        const results = sut.classify([row()], [entryFor(row(), {publishedTime: '2026-11-11T11:55:00+00:00'})], {now: NOW});
        expect(results[0].status).toBe(STATUS.UNCHANGED);
        expect(results[0].problems[0]).toMatch(/the ledger has "2024-05-01T10:00:00\+00:00"/);
      });

      it('flags a ledger version without published-time', () => {
        const results = sut.classify([row()], [entryFor(row(), {publishedTime: ''})], {now: NOW});
        expect(results[0].problems).toHaveLength(1);
      });

      it.each([
        ['missing', ''],
        ['not UTC', '2026-11-11T06:55:00-05:00'],
        ['in the future', '2026-11-11T12:30:00+00:00'],
        ['backdated', '2026-11-01T00:00:00+00:00'],
      ])('flags a new version whose published-time is %s', (_, publishedTime) => {
        const results = sut.classify([], [newEntry({publishedTime})], {now: NOW});
        expect(results[0].status).toBe(STATUS.NEW);
        expect(results[0].problems).toHaveLength(1);
      });

      it('accepts a new version stamped during the build', () => {
        const results = sut.classify([], [newEntry({publishedTime: '2026-11-11T12:01:00+00:00'})], {now: NOW});
        expect(results[0].problems).toEqual([]);
      });
    });

    it('flags metadata whose shasum does not match the archive', () => {
      const results = sut.classify([row()], [entryFor(row(), {shasum: sha1('other')})], {now: NOW});
      expect(results[0].problems[0]).toMatch(/shasum/);
    });

    describe('alias repoint', () => {
      const alias = row({name: 'magento/module-a', version: '100.0.1'});
      const changedAlias = entryFor(alias, {sha1: sha1('repointed'), shasum: sha1('repointed')});
      const aliasKey = sut.rowKey(alias);
      const pointingAt = (version, overrides = {}) => new Map([[aliasKey, {
        name: 'magento/module-a',
        version: '100.0.1',
        target: {name: 'acme/alpha', version},
        ...overrides,
      }]]);

      it('accepts a changed alias requiring a version that is new in this build', () => {
        const results = sut.classify(
          [alias, row()],
          [changedAlias, entryFor(row()), newEntry({version: '2.0.0'})],
          {aliasTargets: pointingAt('2.0.0'), now: NOW}
        );
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.REPOINTED);
        expect(sut.gateFailures(results)).toEqual([]);
      });

      it('reports a changed alias requiring an already published version as modified', () => {
        const results = sut.classify(
          [alias, row()],
          [changedAlias, entryFor(row()), newEntry({version: '2.0.0'})],
          {aliasTargets: pointingAt('1.0.0'), now: NOW}
        );
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
      });

      it('reports a changed alias requiring a version that is not part of the build as modified', () => {
        const results = sut.classify([alias], [changedAlias], {aliasTargets: pointingAt('9.9.9'), now: NOW});
        expect(results[0].status).toBe(STATUS.MODIFIED);
      });

      it('reports an alias archive declaring another package as modified', () => {
        const results = sut.classify(
          [alias],
          [changedAlias, newEntry({version: '2.0.0'})],
          {aliasTargets: pointingAt('2.0.0', {name: 'magento/module-b'}), now: NOW}
        );
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
      });

      it('reports a changed alias as modified without alias information', () => {
        const results = sut.classify([alias], [changedAlias, newEntry({version: '2.0.0'})], {now: NOW});
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
      });
    });
  });

  describe('gateFailures', () => {
    const changed = {sha1: sha1('changed'), shasum: sha1('changed')};

    it('fails on modified and missing versions', () => {
      const results = sut.classify([row(), row({version: '1.1.0'})], [entryFor(row(), changed)], {now: NOW});
      expect(sut.gateFailures(results)).toEqual([
        '1 already published version(s) modified',
        '1 already published version(s) missing from the build',
      ]);
    });

    it('accepts modified and missing versions with allowChanges', () => {
      const results = sut.classify([row(), row({version: '1.1.0'})], [entryFor(row(), changed)], {now: NOW});
      expect(sut.gateFailures(results, {allowChanges: true})).toEqual([]);
    });

    it('fails on re-stamped published-times even with allowChanges', () => {
      const rows = [row(), row({version: '1.1.0'})];
      const restamped = rows.map(r => entryFor(r, {publishedTime: '2026-11-11T11:55:00+00:00'}));
      const results = sut.classify(rows, restamped, {now: NOW});
      expect(sut.gateFailures(results, {allowChanges: true})).toEqual([
        '2 version(s) with a published-time or shasum problem',
      ]);
    });

    it('fails on a backdated new version even with allowChanges', () => {
      const results = sut.classify([], [newEntry({publishedTime: '2020-01-01T00:00:00+00:00'})], {now: NOW});
      expect(sut.gateFailures(results, {allowChanges: true})).toHaveLength(1);
    });
  });

  describe('nextRows', () => {
    it('fills in the sha256 of unchanged versions and keeps everything else', () => {
      const results = sut.classify([row()], [entryFor(row())], {now: NOW});
      expect(sut.nextRows(results)).toEqual([row({sha256: sha256('acme/alpha 1.0.0')})]);
    });

    it('does not replace a recorded sha256', () => {
      const rows = [row({sha256: sha256('acme/alpha 1.0.0')})];
      expect(sut.nextRows(sut.classify(rows, [entryFor(rows[0])], {now: NOW}))).toEqual(rows);
    });

    it('appends new versions with the published-time satis stamped', () => {
      const results = sut.classify([], [newEntry({version: '2.0.0'})], {now: NOW});
      expect(sut.nextRows(results)).toEqual([row({
        version: '2.0.0',
        sha256: sha256('acme/alpha 2.0.0'),
        'published-time': '2026-11-11T11:55:00+00:00',
        source: 'build',
      })]);
    });

    it('records the hashes of modified and repointed versions but keeps their published-time', () => {
      const changed = {sha1: sha1('changed'), sha256: sha256('changed'), shasum: sha1('changed')};
      const results = sut.classify([row()], [entryFor(row(), changed)], {now: NOW});
      expect(sut.nextRows(results)).toEqual([row({sha1: sha1('changed'), sha256: sha256('changed')})]);
    });

    it('drops missing versions and keeps expected differences as recorded', () => {
      const project = row({name: 'acme/project-community-edition'});
      const results = sut.classify(
        [project, row()],
        [entryFor(project, {sha1: sha1('preview'), shasum: sha1('preview')})],
        {expectDiff: ['*/project-community-edition-*'], now: NOW}
      );
      expect(sut.nextRows(results)).toEqual([project]);
    });
  });

  describe('readAliasTarget', () => {
    async function writeZip(files) {
      const zip = new JSZip();
      Object.entries(files).forEach(([name, content]) => zip.file(name, content));
      const file = path.join(dir, 'alias.zip');
      fs.writeFileSync(file, await zip.generateAsync({type: 'nodebuffer'}));
      return file;
    }

    const aliasComposerJson = (overrides = {}) => JSON.stringify({
      name: 'magento/module-a',
      description: 'Alias metapackage for acme/module-a.',
      type: 'metapackage',
      version: '100.0.1',
      require: {'acme/module-a': '2.0.0'},
      ...overrides,
    });

    it('returns the package an alias metapackage requires', async () => {
      const file = await writeZip({'composer.json': aliasComposerJson()});
      expect(await sut.readAliasTarget(file)).toEqual({
        name: 'magento/module-a',
        version: '100.0.1',
        target: {name: 'acme/module-a', version: '2.0.0'},
      });
    });

    it.each([
      ['contains other files', {'composer.json': aliasComposerJson(), 'registration.php': '<?php'}],
      ['is no metapackage', {'composer.json': aliasComposerJson({type: 'magento2-module'})}],
      ['requires several packages', {'composer.json': aliasComposerJson({require: {'acme/a': '1', 'acme/b': '1'}})}],
      ['declares anything besides the alias', {'composer.json': aliasComposerJson({autoload: {files: ['x.php']}})}],
      ['has no valid composer.json', {'composer.json': '{'}],
      ['is not in the magento vendor namespace', {'composer.json': aliasComposerJson({name: 'acme/module-a'})}],
    ])('returns null for an archive that %s', async (_, files) => {
      expect(await sut.readAliasTarget(await writeZip(files))).toBeNull();
    });
  });

  describe('satis output', () => {
    function writeJson(file, data) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
      fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
    }

    function metadata(name, version, content, publishedTime, extra = {}) {
      return {
        name,
        version,
        version_normalized: `${version}.0`,
        dist: {type: 'zip', url: `${REPO_URL}packages/${name}-${version}.zip`, shasum: sha1(content)},
        ...(publishedTime ? {'published-time': publishedTime} : {}),
        ...extra,
      };
    }

    function writeBuild(packages) {
      writeJson('packages.json', {'metadata-url': '/p2/%package%.json', 'available-packages': Object.keys(packages)});
      for (const [name, versions] of Object.entries(packages)) {
        writeJson(`p2/${name}.json`, {packages: {[name]: versions.map(v => metadata(name, v.version, v.content, v.time))}});
        writeJson(`p2/${name}~dev.json`, {packages: {[name]: []}});
        for (const v of versions) {
          fs.mkdirSync(path.dirname(path.join(dir, 'packages', name)), {recursive: true});
          fs.writeFileSync(path.join(dir, 'packages', `${name}-${v.version}.zip`), v.content);
        }
      }
    }

    const ledgerRow = (name, version, content, time) => row({
      name, version, sha1: sha1(content), 'published-time': time,
    });

    it('reads stable and dev versions from the p2 metadata', () => {
      writeJson('packages.json', {'available-packages': ['acme/alpha']});
      writeJson('p2/acme/alpha.json', {packages: {'acme/alpha': [metadata('acme/alpha', '1.0.0', 'a', '2024-05-01T10:00:00+00:00')]}});
      writeJson('p2/acme/alpha~dev.json', {packages: {'acme/alpha': [
        metadata('acme/alpha', '1.1-dev', 'b', '2024-06-01T10:00:00+00:00', {version_normalized: '1.1.0.0-dev'}),
      ]}});

      expect(sut.readSatisOutput(dir, 'https://repo.example.com')).toEqual([
        {
          name: 'acme/alpha', version: '1.0.0', version_normalized: '1.0.0.0', path: 'acme/alpha-1.0.0.zip',
          shasum: sha1('a'), publishedTime: '2024-05-01T10:00:00+00:00',
        },
        {
          name: 'acme/alpha', version: '1.1-dev', version_normalized: '1.1.0.0-dev', path: 'acme/alpha-1.1-dev.zip',
          shasum: sha1('b'), publishedTime: '2024-06-01T10:00:00+00:00',
        },
      ]);
    });

    it('rejects a dist url outside of the repository', () => {
      writeJson('packages.json', {'available-packages': ['acme/alpha']});
      writeJson('p2/acme/alpha.json', {packages: {'acme/alpha': [
        {...metadata('acme/alpha', '1.0.0', 'a'), dist: {url: 'https://elsewhere.example.com/packages/acme/alpha-1.0.0.zip'}},
      ]}});
      expect(() => sut.readSatisOutput(dir, REPO_URL)).toThrow(/is not below/);
    });

    it('rejects minified metadata and packages without metadata', () => {
      writeJson('packages.json', {'available-packages': ['acme/alpha']});
      expect(() => sut.readSatisOutput(dir, REPO_URL)).toThrow(/No p2 metadata/);
      writeJson('p2/acme/alpha.json', {minified: 'composer/2.0', packages: {'acme/alpha': []}});
      expect(() => sut.readSatisOutput(dir, REPO_URL)).toThrow(/Minified/);
    });

    it('verifies a build against the ledger by hashing the archives', async () => {
      const stamped = sut.formatTime(new Date());
      writeBuild({
        'acme/alpha': [
          {version: '1.0.0', content: 'alpha 1.0.0', time: '2024-05-01T10:00:00+00:00'},
          {version: '1.1.0', content: 'alpha 1.1.0 rebuilt differently', time: '2024-06-01T10:00:00+00:00'},
          {version: '2.0.0', content: 'alpha 2.0.0', time: stamped},
        ],
      });
      const rows = [
        ledgerRow('acme/alpha', '1.0.0', 'alpha 1.0.0', '2024-05-01T10:00:00+00:00'),
        ledgerRow('acme/alpha', '1.1.0', 'alpha 1.1.0', '2024-06-01T10:00:00+00:00'),
        ledgerRow('acme/gone', '1.0.0', 'gone', '2024-06-01T10:00:00+00:00'),
      ];

      const results = await sut.verifyBuild(rows, {satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL});

      expect(statusOf(results, 'acme/alpha', '1.0.0')).toBe(STATUS.UNCHANGED);
      expect(statusOf(results, 'acme/alpha', '1.1.0')).toBe(STATUS.MODIFIED);
      expect(statusOf(results, 'acme/alpha', '2.0.0')).toBe(STATUS.NEW);
      expect(statusOf(results, 'acme/gone', '1.0.0')).toBe(STATUS.MISSING);
      expect(results[0].entry.sha256).toBe(sha256('alpha 1.0.0'));
      expect(sut.summarize(results).problems).toBe(0);
    });

    it('fails the gate when satis stamped ledger versions with a new published-time', async () => {
      const stamped = sut.formatTime(new Date());
      writeBuild({
        'acme/alpha': [
          {version: '1.0.0', content: 'alpha 1.0.0', time: stamped},
          {version: '1.1.0', content: 'alpha 1.1.0', time: stamped},
        ],
      });
      const rows = [
        ledgerRow('acme/alpha', '1.0.0', 'alpha 1.0.0', '2024-05-01T10:00:00+00:00'),
        ledgerRow('acme/alpha', '1.1.0', 'alpha 1.1.0', '2024-06-01T10:00:00+00:00'),
      ];

      const results = await sut.verifyBuild(rows, {satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL});

      expect(sut.summarize(results)).toMatchObject({unchanged: 2, problems: 2});
      expect(sut.gateFailures(results, {allowChanges: true})).toHaveLength(1);
    });

    it('fails the gate when the metadata has no published-time at all', async () => {
      writeBuild({'acme/alpha': [{version: '1.0.0', content: 'alpha 1.0.0'}, {version: '2.0.0', content: 'alpha 2.0.0'}]});
      const rows = [ledgerRow('acme/alpha', '1.0.0', 'alpha 1.0.0', '2024-05-01T10:00:00+00:00')];

      const results = await sut.verifyBuild(rows, {satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL});

      expect(sut.summarize(results).problems).toBe(2);
    });

    it('only accepts a repointed alias when asked to', async () => {
      const zip = new JSZip();
      zip.file('composer.json', JSON.stringify({
        name: 'magento/module-a',
        type: 'metapackage',
        version: '100.0.1',
        require: {'acme/alpha': '2.0.0'},
      }));
      const aliasContent = await zip.generateAsync({type: 'nodebuffer'});
      const stamped = sut.formatTime(new Date());
      writeBuild({
        'acme/alpha': [{version: '2.0.0', content: 'alpha 2.0.0', time: stamped}],
        'magento/module-a': [{version: '100.0.1', content: aliasContent, time: '2024-05-01T10:00:00+00:00'}],
      });
      const rows = [ledgerRow('magento/module-a', '100.0.1', 'alias requiring alpha 1.0.0', '2024-05-01T10:00:00+00:00')];
      const options = {satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL};

      const strict = await sut.verifyBuild(rows, options);
      const lenient = await sut.verifyBuild(rows, {...options, allowAliasRepoint: true});

      expect(statusOf(strict, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
      expect(statusOf(lenient, 'magento/module-a', '100.0.1')).toBe(STATUS.REPOINTED);
    });
  });

  describe('fetchRepoEntries', () => {
    const version = (name, v, extra = {}) => ({
      name,
      version: v,
      version_normalized: `${v}.0`,
      dist: {type: 'zip', url: `${REPO_URL}packages/${name}-${v}.zip`, shasum: sha1(`${name} ${v}`)},
      ...extra,
    });

    function fakeFetch(responses) {
      return jest.fn(async url => {
        if (!(url in responses)) {
          throw Object.assign(new Error(`HTTP 404 for ${url}`), {status: 404});
        }
        return responses[url];
      });
    }

    it('reads all versions from the include files', async () => {
      const fetchJson = fakeFetch({
        [`${REPO_URL}packages.json`]: {includes: {'include/all$abc.json': {sha1: 'abc'}}},
        [`${REPO_URL}include/all$abc.json`]: {packages: {
          'acme/alpha': {'1.0.0': version('acme/alpha', '1.0.0'), '1.1.0': version('acme/alpha', '1.1.0')},
        }},
      });

      const entries = await sut.fetchRepoEntries('https://repo.example.com', fetchJson);

      expect(entries).toEqual([
        {name: 'acme/alpha', version: '1.0.0', version_normalized: '1.0.0.0', path: 'acme/alpha-1.0.0.zip', sha1: sha1('acme/alpha 1.0.0')},
        {name: 'acme/alpha', version: '1.1.0', version_normalized: '1.1.0.0', path: 'acme/alpha-1.1.0.zip', sha1: sha1('acme/alpha 1.1.0')},
      ]);
    });

    it('reads versions and published-time from the p2 metadata', async () => {
      const fetchJson = fakeFetch({
        [`${REPO_URL}packages.json`]: {'available-packages': ['acme/alpha', 'acme/beta']},
        [`${REPO_URL}p2/acme/alpha.json`]: {packages: {'acme/alpha': [
          version('acme/alpha', '1.0.0', {'published-time': '2024-05-01T10:00:00+00:00'}),
        ]}},
        [`${REPO_URL}p2/acme/alpha~dev.json`]: {packages: {'acme/alpha': []}},
        [`${REPO_URL}p2/acme/beta.json`]: {packages: {'acme/beta': [version('acme/beta', '1.0.0')]}},
      });

      const entries = await sut.fetchRepoEntries(REPO_URL, fetchJson, {fromMetadataUrl: true});

      expect(entries.map(e => [e.name, e.publishedTime])).toEqual([
        ['acme/alpha', '2024-05-01T10:00:00+00:00'],
        ['acme/beta', ''],
      ]);
    });

    it('does not hide request failures', async () => {
      const fetchJson = jest.fn(async url => {
        if (url.endsWith('packages.json')) {
          return {'available-packages': ['acme/alpha']};
        }
        throw Object.assign(new Error('HTTP 500'), {status: 500});
      });
      await expect(sut.fetchRepoEntries(REPO_URL, fetchJson, {fromMetadataUrl: true})).rejects.toThrow('HTTP 500');
    });

    it('lets an audit detect injected, changed and removed versions', async () => {
      const rows = [row(), row({version: '1.1.0'}), row({version: '1.2.0'})];
      const live = [
        entryFor(rows[0]),
        entryFor(rows[1], {sha1: sha1('tampered')}),
        newEntry({version: '6.6.6'}),
      ].map(({name, version: v, version_normalized, path: archivePath, sha1: hash}) => (
        {name, version: v, version_normalized, path: archivePath, sha1: hash}
      ));

      expect(sut.summarize(sut.classify(rows, live))).toMatchObject({unchanged: 1, modified: 1, new: 1, missing: 1});
    });
  });

  describe('bootstrapRows', () => {
    const entry = {name: 'acme/alpha', version: '1.0.0', version_normalized: '1.0.0.0', path: 'acme/alpha-1.0.0.zip', sha1: sha1('a')};
    const DEFAULT = '2026-01-01T00:00:00+00:00';

    it('uses the known publication time, normalized to UTC', () => {
      const times = sut.parseTimes('acme/alpha\t1.0.0\t2024-05-01T05:00:00-05:00\tupstream\n');
      expect(sut.bootstrapRows([entry], times, {now: NOW})).toEqual([{
        ...entry,
        sha256: '',
        'published-time': '2024-05-01T10:00:00+00:00',
        source: 'upstream',
      }]);
    });

    it('falls back to the default time, recorded as bootstrap', () => {
      const [result] = sut.bootstrapRows([entry], new Map(), {defaultTime: DEFAULT, now: NOW});
      expect(result).toMatchObject({'published-time': DEFAULT, source: 'bootstrap'});
    });

    it('never records a time in the future', () => {
      const times = sut.parseTimes('acme/alpha\t1.0.0\t2026-12-01T00:00:00+00:00\tupstream\n');
      const [result] = sut.bootstrapRows([entry], times, {defaultTime: DEFAULT, now: NOW});
      expect(result).toMatchObject({'published-time': DEFAULT, source: 'bootstrap'});
    });

    it('throws if a version has no time and there is no default', () => {
      expect(() => sut.bootstrapRows([entry], new Map(), {now: NOW})).toThrow(/No usable published-time/);
    });

    it('rejects a default time in the future', () => {
      expect(() => sut.bootstrapRows([entry], new Map(), {defaultTime: '2027-01-01T00:00:00+00:00', now: NOW})).toThrow(/future/);
    });
  });

  describe('formatReport', () => {
    const results = sut.classify(
      [row(), row({version: '1.1.0'})],
      [entryFor(row(), {sha1: sha1('changed'), shasum: sha1('changed'), publishedTime: ''}), newEntry({version: '2.0.0'})],
      {now: NOW}
    );

    it('lists the count per status and every version that is not unchanged', () => {
      const report = sut.formatReport(results, {title: 'Ledger'});
      expect(report).toContain('modified  1');
      expect(report).toContain(`acme/alpha  1.0.0  ${row().sha1}  ${sha1('changed')}`);
      expect(report).toContain('acme/alpha  1.1.0');
      expect(report).toContain('Problems');
    });

    it('renders markdown tables and truncates long lists', () => {
      const report = sut.formatReport(results, {title: 'Ledger', markdown: true, limit: 0});
      expect(report).toContain('### Ledger');
      expect(report).toContain('| status | versions |');
      expect(report).toContain('… and 1 more');
    });
  });
});
