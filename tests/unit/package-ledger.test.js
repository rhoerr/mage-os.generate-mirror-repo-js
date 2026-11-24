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
    'metadata-sha256': sut.metadataSha256({name, version}),
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
    metadataSha256: ledgerRow['metadata-sha256'],
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
      ['metadata-sha256', {'metadata-sha256': ''}],
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
      expect(() => sut.parseLedger(text + 'acme/alpha\t1.0.0\n')).toThrow(/expected 9 fields/);
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

  describe('metadataSha256', () => {
    const composerJson = {
      name: 'acme/alpha',
      description: 'Not hashed',
      version: '1.0.0',
      require: {php: '>=8.1', 'Acme/Beta': '^2.0'},
      'require-dev': {},
      autoload: {'psr-4': {'Acme\\Alpha\\': ''}, files: ['registration.php']},
      extra: {map: {}, 'branch-alias': {'dev-main': '1.0-dev'}},
    };

    // What satis writes for that composer.json
    const satisEntry = {
      name: 'acme/alpha',
      version: '1.0.0',
      version_normalized: '1.0.0.0',
      dist: {type: 'zip', url: `${REPO_URL}packages/acme/alpha-1.0.0.zip`, shasum: sha1('a')},
      require: {'acme/beta': '^2.0', php: '>=8.1'},
      type: 'library',
      extra: {'branch-alias': {'dev-main': '1.0-dev'}, map: []},
      autoload: {files: ['registration.php'], 'psr-4': {'Acme\\Alpha\\': ''}},
      description: 'Not hashed either',
      'published-time': '2024-05-01T10:00:00+00:00',
    };

    it('is the same for a composer.json and the satis metadata generated from it', async () => {
      const zip = new JSZip();
      zip.file('composer.json', JSON.stringify(composerJson, null, 4));
      const archive = path.join(dir, 'alpha.zip');
      fs.writeFileSync(archive, await zip.generateAsync({type: 'nodebuffer'}));
      const {readComposerJsonFromZip} = require('../../src/package-aliases');

      expect(sut.metadataSha256(await readComposerJsonFromZip(archive))).toBe(sut.metadataSha256(satisEntry));
      expect(sut.metadataSha256(satisEntry)).toBe('76a97c182ddb7808cbc9564930f5207db6592b977c775242a8065776ea34743b');
    });

    it.each([
      ['a require constraint', {require: {...composerJson.require, php: '>=8.2'}}],
      ['the type', {type: 'magento2-module'}],
      ['the autoload files order', {autoload: {...composerJson.autoload, files: ['a.php', 'registration.php']}}],
      ['the version', {version: '1.0.1'}],
    ])('changes with %s', (_, overrides) => {
      expect(sut.metadataSha256({...composerJson, ...overrides})).not.toBe(sut.metadataSha256(composerJson));
    });
  });

  describe('classify', () => {
    it('flags an unchanged archive whose metadata does not match the ledger', () => {
      const results = sut.classify([row()], [entryFor(row(), {metadataSha256: sha256('other')})], {now: NOW});
      expect(results[0].status).toBe(STATUS.UNCHANGED);
      expect(results[0].problems).toEqual([expect.stringMatching(/metadata-sha256 .* does not match the ledger/)]);
    });

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

      const replacedBy = (version, name = 'acme/alpha') => new Map([['magento/module-a:100.0.1', {
        magentoName: 'magento/module-a',
        magentoVersion: '100.0.1',
        mageOsName: name,
        mageOsVersion: version,
      }]]);
      const aliasStatus = options => statusOf(
        sut.classify([alias, row()], [changedAlias, entryFor(row()), newEntry({version: '2.0.0'})], {now: NOW, ...options}),
        'magento/module-a',
        '100.0.1'
      );

      it('accepts a changed alias requiring the highest version replacing it', () => {
        const results = sut.classify(
          [alias, row()],
          [changedAlias, entryFor(row()), newEntry({version: '2.0.0'})],
          {aliasTargets: pointingAt('2.0.0'), replacers: replacedBy('2.0.0'), now: NOW}
        );
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.REPOINTED);
        expect(sut.gateFailures(results)).toEqual([]);
      });

      it('accepts a changed alias requiring an already published version if that replaces it', () => {
        expect(aliasStatus({aliasTargets: pointingAt('1.0.0'), replacers: replacedBy('1.0.0')})).toBe(STATUS.REPOINTED);
      });

      it('reports a changed alias requiring an older version than the highest replacing it as modified', () => {
        expect(aliasStatus({aliasTargets: pointingAt('1.0.0'), replacers: replacedBy('2.0.0')})).toBe(STATUS.MODIFIED);
      });

      it('reports a changed alias requiring a package that does not replace it as modified', () => {
        expect(aliasStatus({aliasTargets: pointingAt('2.0.0'), replacers: replacedBy('2.0.0', 'acme/beta')})).toBe(STATUS.MODIFIED);
      });

      it('reports a changed alias nothing in the build replaces as modified', () => {
        expect(aliasStatus({aliasTargets: pointingAt('2.0.0')})).toBe(STATUS.MODIFIED);
      });

      it('reports an alias archive declaring another package as modified', () => {
        const aliasTargets = pointingAt('2.0.0', {name: 'magento/module-b'});
        expect(aliasStatus({aliasTargets, replacers: replacedBy('2.0.0')})).toBe(STATUS.MODIFIED);
      });

      it('reports a changed alias as modified without alias information', () => {
        expect(aliasStatus({replacers: replacedBy('2.0.0')})).toBe(STATUS.MODIFIED);
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

    it('has no override for modified and missing versions', () => {
      const results = sut.classify([row(), row({version: '1.1.0'})], [entryFor(row(), changed)], {now: NOW});
      expect(sut.gateFailures(results, {allowChanges: true})).toHaveLength(2);
    });

    it('fails on re-stamped published-times', () => {
      const rows = [row(), row({version: '1.1.0'})];
      const restamped = rows.map(r => entryFor(r, {publishedTime: '2026-11-11T11:55:00+00:00'}));
      const results = sut.classify(rows, restamped, {now: NOW});
      expect(sut.gateFailures(results)).toEqual([
        '2 version(s) with a published-time or shasum problem',
      ]);
    });

    it('fails on a backdated new version', () => {
      const results = sut.classify([], [newEntry({publishedTime: '2020-01-01T00:00:00+00:00'})], {now: NOW});
      expect(sut.gateFailures(results)).toHaveLength(1);
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

    it('records the hashes of repointed aliases but keeps their published-time', () => {
      const alias = row({name: 'magento/module-a', version: '100.0.1'});
      const changed = {sha1: sha1('changed'), sha256: sha256('changed'), shasum: sha1('changed')};
      const results = sut.classify([alias], [entryFor(alias, changed)], {
        aliasTargets: new Map([[sut.rowKey(alias), {name: 'magento/module-a', version: '100.0.1', target: {name: 'acme/alpha', version: '2.0.0'}}]]),
        replacers: new Map([['magento/module-a:100.0.1', {mageOsName: 'acme/alpha', mageOsVersion: '2.0.0'}]]),
        now: NOW,
      });
      expect(results[0].status).toBe(STATUS.REPOINTED);
      expect(sut.nextRows(results)).toEqual([{...alias, sha1: sha1('changed'), sha256: sha256('changed')}]);
    });

    it('refuses to record modified or missing versions', () => {
      const changed = {sha1: sha1('changed'), shasum: sha1('changed')};
      expect(() => sut.nextRows(sut.classify([row()], [entryFor(row(), changed)], {now: NOW}))).toThrow(/modified/);
      expect(() => sut.nextRows(sut.classify([row()], [], {now: NOW}))).toThrow(/missing/);
    });

    it('keeps expected differences as recorded', () => {
      const project = row({name: 'acme/project-community-edition'});
      const results = sut.classify(
        [project],
        [entryFor(project, {sha1: sha1('preview'), shasum: sha1('preview')})],
        {expectDiff: ['*/project-community-edition-*'], now: NOW}
      );
      expect(sut.nextRows(results)).toEqual([project]);
    });
  });

  describe('guardFailures', () => {
    const rows = [row({name: 'mage-os/product-community-edition', version: '2.0.0'})];

    it('accepts a production release that publishes its tag', () => {
      expect(sut.guardFailures(rows, {target: 'production', mageosRelease: '2.1.0', publishTag: true})).toEqual([]);
    });

    it('accepts deploys without a release', () => {
      expect(sut.guardFailures(rows, {target: 'production', mageosRelease: '', publishTag: false})).toEqual([]);
      expect(sut.guardFailures(rows, {target: 'preview', mageosRelease: '', publishTag: false})).toEqual([]);
    });

    it('accepts a preview of a new release without a tag', () => {
      expect(sut.guardFailures(rows, {target: 'preview', mageosRelease: '2.1.0', publishTag: false})).toEqual([]);
    });

    it('requires a production release to publish its tag', () => {
      expect(sut.guardFailures(rows, {target: 'production', mageosRelease: '2.1.0', publishTag: false})).toEqual([
        'A production deploy of release 2.1.0 has to publish the release tag',
      ]);
    });

    it('refuses to publish a tag from a preview', () => {
      expect(sut.guardFailures(rows, {target: 'preview', mageosRelease: '2.1.0', publishTag: true})).toEqual([
        'A preview deploy can not publish a release tag',
      ]);
    });

    it.each(['production', 'preview'])('refuses a release that is already in the ledger on %s', target => {
      expect(sut.guardFailures(rows, {target, mageosRelease: '2.0.0', publishTag: target === 'production'})).toEqual([
        'Release 2.0.0 is already published: mage-os/product-community-edition 2.0.0 is in the ledger',
      ]);
    });

    it('only looks at the release metapackage', () => {
      const moduleRows = [row({name: 'mage-os/module-catalog', version: '2.1.0'})];
      expect(sut.guardFailures(moduleRows, {target: 'production', mageosRelease: '2.1.0', publishTag: true})).toEqual([]);
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
          metadataSha256: sut.metadataSha256({name: 'acme/alpha', version: '1.0.0'}),
        },
        {
          name: 'acme/alpha', version: '1.1-dev', version_normalized: '1.1.0.0-dev', path: 'acme/alpha-1.1-dev.zip',
          shasum: sha1('b'), publishedTime: '2024-06-01T10:00:00+00:00',
          metadataSha256: sut.metadataSha256({name: 'acme/alpha', version: '1.1-dev'}),
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
      expect(sut.gateFailures(results)).toHaveLength(1);
    });

    it('fails the gate when the metadata has no published-time at all', async () => {
      writeBuild({'acme/alpha': [{version: '1.0.0', content: 'alpha 1.0.0'}, {version: '2.0.0', content: 'alpha 2.0.0'}]});
      const rows = [ledgerRow('acme/alpha', '1.0.0', 'alpha 1.0.0', '2024-05-01T10:00:00+00:00')];

      const results = await sut.verifyBuild(rows, {satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL});

      expect(sut.summarize(results).problems).toBe(2);
    });

    describe('alias repoint', () => {
      const ALIAS_TIME = '2024-05-01T10:00:00+00:00';
      const options = () => ({satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL});
      const rows = [ledgerRow('magento/module-a', '100.0.1', 'alias requiring mage-os/module-a 1.0.0', ALIAS_TIME)];

      async function zipOf(composer) {
        const zip = new JSZip();
        zip.file('composer.json', JSON.stringify(composer));
        return zip.generateAsync({type: 'nodebuffer'});
      }

      const replacer = version => zipOf({name: 'mage-os/module-a', version, replace: {'magento/module-a': '100.0.1'}});
      const aliasRequiring = version => zipOf({
        name: 'magento/module-a',
        type: 'metapackage',
        version: '100.0.1',
        require: {'mage-os/module-a': version},
      });

      async function writeAliasBuild(replacerVersions, aliasTarget) {
        const stamped = sut.formatTime(new Date());
        const aliasContent = await aliasRequiring(aliasTarget);
        writeBuild({
          'mage-os/module-a': await Promise.all(replacerVersions.map(async version => (
            {version, content: await replacer(version), time: stamped}
          ))),
          'magento/module-a': [{version: '100.0.1', content: aliasContent, time: ALIAS_TIME}],
        });
        return aliasContent;
      }

      it('only accepts a repointed alias when asked to', async () => {
        const aliasContent = await writeAliasBuild(['1.0.0', '2.0.0'], '2.0.0');

        const strict = await sut.verifyBuild(rows, options());
        const lenient = await sut.verifyBuild(rows, {...options(), allowAliasRepoint: true});

        expect(statusOf(strict, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
        expect(statusOf(lenient, 'magento/module-a', '100.0.1')).toBe(STATUS.REPOINTED);
        expect(sut.gateFailures(lenient)).toEqual([]);
        expect(sut.nextRows(lenient).find(r => r.name === 'magento/module-a')).toEqual({
          ...rows[0],
          sha1: sha1(aliasContent),
          sha256: sha256(aliasContent),
        });
      });

      it('rejects an alias requiring an older version than the highest one replacing it in the build', async () => {
        await writeAliasBuild(['1.0.0', '2.0.0'], '1.0.0');
        const results = await sut.verifyBuild(rows, {...options(), allowAliasRepoint: true});
        expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.MODIFIED);
      });

      it('fails on a mage-os archive it can not read', async () => {
        await writeAliasBuild(['2.0.0'], '2.0.0');
        fs.writeFileSync(path.join(dir, 'packages', 'mage-os', 'module-a-2.0.0.zip'), 'no zip');
        await expect(sut.verifyBuild(rows, {...options(), allowAliasRepoint: true})).rejects.toThrow();
      });
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

      expect(entries).toEqual(['1.0.0', '1.1.0'].map(v => ({
        name: 'acme/alpha',
        version: v,
        version_normalized: `${v}.0`,
        path: `acme/alpha-${v}.zip`,
        sha1: sha1(`acme/alpha ${v}`),
        metadataSha256: sut.metadataSha256({name: 'acme/alpha', version: v}),
      })));
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

    it('reads the given packages.json instead of fetching it', async () => {
      const fetchJson = fakeFetch({
        [`${REPO_URL}p2/acme/alpha.json`]: {packages: {'acme/alpha': [version('acme/alpha', '1.0.0')]}},
      });

      const entries = await sut.fetchRepoEntries(REPO_URL, fetchJson, {
        fromMetadataUrl: true,
        packagesJson: {'available-packages': ['acme/alpha']},
      });

      expect(entries.map(e => e.name)).toEqual(['acme/alpha']);
      expect(fetchJson).not.toHaveBeenCalledWith(`${REPO_URL}packages.json`);
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

    it.each(['../all.json', '/etc/all.json'])('does not fetch the include file %s outside of the repository', async include => {
      const fetchJson = fakeFetch({[`${REPO_URL}packages.json`]: {includes: {[include]: {sha1: 'abc'}}}});
      await expect(sut.fetchRepoEntries(REPO_URL, fetchJson)).rejects.toThrow(/outside/);
      expect(fetchJson).toHaveBeenCalledTimes(1);
    });
  });

  describe('packagesJsonProblems', () => {
    const SATIS = {
      packages: [],
      includes: {'include/all$0123456789abcdef0123456789abcdef01234567.json': {sha1: '0123456789abcdef0123456789abcdef01234567'}},
      'metadata-url': '/p2/%package%.json',
      'available-packages': ['acme/alpha', 'acme/beta'],
    };

    it('accepts what satis writes', () => {
      expect(sut.packagesJsonProblems(SATIS, 'https://repo.example.com')).toEqual([]);
      expect(sut.packagesJsonProblems({...SATIS, 'metadata-url': '/sub/p2/%package%.json'}, 'https://repo.example.com/sub/')).toEqual([]);
    });

    it.each([
      ['providers', {'providers-url': '/p/%package%$%hash%.json', providers: {}}, ['packages.json: unexpected providers-url', 'packages.json: unexpected providers']],
      ['repositories', {repositories: [{type: 'vcs', url: 'https://evil.example.com/repo.git'}]}, ['packages.json: unexpected repositories']],
      ['inline packages', {packages: {'acme/alpha': {'6.6.6': {}}}}, ['packages.json: packages is not empty']],
      ['another metadata-url', {'metadata-url': 'https://evil.example.com/p2/%package%.json'}, ['packages.json: metadata-url is "https://evil.example.com/p2/%package%.json", not "/p2/%package%.json"']],
      ['an include file above the repository', {includes: {'../all.json': {}}}, ['packages.json: include file outside of the repository: ../all.json']],
      ['an absolute include file', {includes: {'/all.json': {}}}, ['packages.json: include file outside of the repository: /all.json']],
      ['includes that are no object', {includes: ['include/all.json']}, ['packages.json: includes is not an object']],
      ['available-packages that are no list', {'available-packages': {'acme/alpha': true}}, ['packages.json: available-packages is not a list of package names']],
    ])('rejects %s', (_, change, problems) => {
      expect(sut.packagesJsonProblems({...SATIS, ...change}, REPO_URL)).toEqual(problems);
    });

    it('rejects anything but an object', () => {
      expect(sut.packagesJsonProblems([], REPO_URL)).toEqual(['packages.json is not an object']);
      expect(sut.packagesJsonProblems(null, REPO_URL)).toEqual(['packages.json is not an object']);
    });
  });

  describe('bootstrapRows', () => {
    const metadataSha256 = sut.metadataSha256({name: 'acme/alpha', version: '1.0.0'});
    const entry = {name: 'acme/alpha', version: '1.0.0', version_normalized: '1.0.0.0', path: 'acme/alpha-1.0.0.zip', sha1: sha1('a'), metadataSha256};
    const DEFAULT = '2026-01-01T00:00:00+00:00';

    it('uses the known publication time, normalized to UTC', () => {
      const times = sut.parseTimes('acme/alpha\t1.0.0\t2024-05-01T05:00:00-05:00\tupstream\n');
      const {metadataSha256: _, ...fields} = entry;
      expect(sut.bootstrapRows([entry], times, {now: NOW})).toEqual([{
        ...fields,
        sha256: '',
        'metadata-sha256': metadataSha256,
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
  describe('base metadata', () => {
    const TIME = '2024-05-01T10:00:00+00:00';
    const ledgerRows = [row(), row({version: '1.1.0'})];
    const metadataOf = (ledgerRow, extra = {}) => ({
      name: ledgerRow.name,
      version: ledgerRow.version,
      version_normalized: ledgerRow.version_normalized,
      dist: {type: 'zip', url: `${REPO_URL}packages/${ledgerRow.path}`, shasum: ledgerRow.sha1},
      'published-time': ledgerRow['published-time'],
      ...extra,
    });
    const filesOf = versions => [
      {file: 'packages.json', text: JSON.stringify({includes: {'include/all$abc.json': {sha1: 'abc'}}})},
      {file: 'include/all$abc.json', text: JSON.stringify({packages: {'acme/alpha': Object.fromEntries(versions.map(v => [v.version, v]))}})},
    ];
    const failuresOf = versions => sut.baseMetadataFailures(ledgerRows, filesOf(versions), REPO_URL).failures;

    it('accepts metadata with exactly the ledger versions', () => {
      expect(failuresOf(ledgerRows.map(r => metadataOf(r)))).toEqual([]);
    });

    it('fails on a changed require', () => {
      expect(failuresOf([metadataOf(ledgerRows[0], {require: {'acme/evil': '*'}}), metadataOf(ledgerRows[1])]))
        .toEqual(['1 version(s) with a published-time or shasum problem']);
    });

    it('fails on a stale copy without a ledger version', () => {
      expect(failuresOf([metadataOf(ledgerRows[0])])).toEqual(['1 already published version(s) missing from the build']);
    });

    it('fails on a version the ledger does not have', () => {
      const unknown = row({version: '6.6.6'});
      expect(failuresOf([...ledgerRows.map(r => metadataOf(r)), metadataOf(unknown, {'published-time': sut.formatTime(new Date())})]))
        .toEqual(['1 version(s) that are not in the ledger']);
    });

    it('fails on a changed archive or published-time', () => {
      expect(failuresOf([metadataOf(ledgerRows[0], {dist: {type: 'zip', url: `${REPO_URL}packages/${ledgerRows[0].path}`, shasum: sha1('x')}}), metadataOf(ledgerRows[1])]))
        .toEqual(['1 already published version(s) modified']);
      expect(failuresOf([metadataOf(ledgerRows[0], {'published-time': '2025-01-01T00:00:00+00:00'}), metadataOf(ledgerRows[1])]))
        .toEqual(['1 version(s) with a published-time or shasum problem']);
    });

    it('fails on metadata satis generated without published-time', () => {
      const withoutTime = ledgerRows.map(r => {
        const {'published-time': _, ...version} = metadataOf(r);
        return version;
      });
      expect(failuresOf(withoutTime)).toEqual(['2 version(s) with a published-time or shasum problem']);
    });

    it('fetches packages.json and its include files past any cache', async () => {
      const files = filesOf(ledgerRows.map(r => metadataOf(r)));
      const fetchText = jest.fn(async url => {
        const file = url.replace('http://127.0.0.1:1/', '').replace(/\?nocache=\d+$/, '');
        return files.find(f => f.file === file).text;
      });

      expect(await sut.fetchBaseMetadata('http://127.0.0.1:1', fetchText)).toEqual(files);
      expect(fetchText.mock.calls.map(([url]) => url)).toEqual([
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:1\/packages\.json\?nocache=\d+$/),
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:1\/include\/all\$abc\.json\?nocache=\d+$/),
      ]);
    });

    it('does not fetch an include file outside of the repository', async () => {
      const fetchText = async () => JSON.stringify({includes: {'../all.json': {}}});
      await expect(sut.fetchBaseMetadata('http://127.0.0.1:1/', fetchText)).rejects.toThrow(/outside/);
    });

    it('writes the fetched files where satis reads its previous build from', () => {
      const files = filesOf(ledgerRows.map(r => metadataOf(r)));
      sut.writeBaseMetadata(files, dir);

      expect(fs.readFileSync(path.join(dir, 'include/all$abc.json'), 'utf8')).toBe(files[1].text);
      expect(sut.readIncludedVersions(dir).map(v => v.version)).toEqual(['1.0.0', '1.1.0']);
      expect(() => sut.writeBaseMetadata(files, dir)).toThrow(/already exists/);
    });

    it('accepts every field satis writes for the packages built here', () => {
      const full = metadataOf(ledgerRows[0], {
        require: {'php': '~8.3.0'}, 'require-dev': {'acme/test': '*'}, replace: {'acme/old': '*'}, provide: {'acme/api': '1.0'},
        conflict: {'acme/bad': '*'}, suggest: {'acme/extra': 'More'}, type: 'magento2-module',
        autoload: {'psr-4': {'Acme\\Alpha\\': ''}}, 'autoload-dev': {'psr-4': {'Acme\\Alpha\\Test\\': 'Test/'}},
        extra: {map: [['a', 'b']]}, bin: ['bin/alpha'], license: ['OSL-3.0'], description: 'Alpha', abandoned: true,
        scripts: {test: 'phpunit'}, authors: [{name: 'Acme'}], support: {issues: 'https://acme.example.com'},
        archive: {exclude: ['/Test']}, homepage: 'https://acme.example.com', keywords: ['alpha'],
        funding: [{type: 'github', url: 'https://github.com/sponsors/acme'}],
      });
      const rows = [{...ledgerRows[0], 'metadata-sha256': sut.metadataSha256(full)}, ledgerRows[1]];
      expect(sut.baseMetadataFailures(rows, filesOf([full, metadataOf(ledgerRows[1])]), REPO_URL).failures).toEqual([]);
    });

    it.each([
      ['a source composer falls back to', {source: {type: 'git', url: 'https://evil.example.com/alpha.git', reference: 'main'}}, /unexpected source$/],
      ['an include-path', {'include-path': ['../../evil']}, /unexpected include-path$/],
      ['transport-options', {'transport-options': {ssl: {verify_peer: false}}}, /unexpected transport-options$/],
      ['a notification-url', {'notification-url': 'https://evil.example.com/notify'}, /unexpected notification-url$/],
      ['a dist reference', {dist: {type: 'zip', url: `${REPO_URL}packages/${ledgerRows[0].path}`, shasum: ledgerRows[0].sha1, reference: 'abc'}}, /unexpected dist reference$/],
      ['dist mirrors', {dist: {type: 'zip', url: `${REPO_URL}packages/${ledgerRows[0].path}`, shasum: ledgerRows[0].sha1, mirrors: [{url: 'https://evil.example.com/%package%', preferred: true}]}}, /unexpected dist mirrors$/],
      ['a dist type other than zip', {dist: {type: 'tar', url: `${REPO_URL}packages/${ledgerRows[0].path}`, shasum: ledgerRows[0].sha1}}, /dist type "tar" is not zip$/],
    ])('rejects a version with %s', (_, extra, message) => {
      expect(sut.baseMetadataFailures(ledgerRows, filesOf([metadataOf(ledgerRows[0], extra), metadataOf(ledgerRows[1])]), REPO_URL)).toEqual({
        results: null,
        failures: [expect.stringMatching(message)],
      });
    });

    it('fails on a packages.json satis did not write', () => {
      const [packagesJson, include] = filesOf(ledgerRows.map(r => metadataOf(r)));
      const tampered = {file: 'packages.json', text: JSON.stringify({...JSON.parse(packagesJson.text), 'providers-url': '/p/%package%$%hash%.json'})};
      expect(sut.baseMetadataFailures(ledgerRows, [tampered, include], REPO_URL).failures).toEqual(['packages.json: unexpected providers-url']);
    });

    it('rejects a version without dist, which is what a seed satis did not replace looks like', () => {
      const files = filesOf([{name: 'acme/alpha', version: '1.0.0', version_normalized: '1.0.0.0', 'published-time': TIME}]);
      expect(sut.baseMetadataFailures(ledgerRows, files, REPO_URL)).toEqual({
        results: null,
        failures: [expect.stringMatching(/no dist/)],
      });
    });
  });

  describe('incremental verifyBuild', () => {
    const TIME = '2024-05-01T10:00:00+00:00';

    function writeJson(file, data) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
      fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
    }

    async function zipOf(composer) {
      const zip = new JSZip();
      zip.file('composer.json', JSON.stringify(composer));
      return zip.generateAsync({type: 'nodebuffer'});
    }

    // versions: {name, version, content|null, time, extra}; null content means no archive in the build
    function writeBuild(versions) {
      const names = [...new Set(versions.map(v => v.name))];
      writeJson('packages.json', {'available-packages': names});
      for (const name of names) {
        writeJson(`p2/${name}.json`, {packages: {[name]: versions.filter(v => v.name === name).map(v => ({
          name,
          version: v.version,
          version_normalized: `${v.version}.0`,
          dist: {type: 'zip', url: `${REPO_URL}packages/${name}-${v.version}.zip`, shasum: v.shasum || sha1(v.content)},
          'published-time': v.time || TIME,
          ...(v.extra || {}),
        }))}});
      }
      for (const v of versions.filter(v => v.content !== null)) {
        fs.mkdirSync(path.join(dir, 'packages', path.dirname(v.name)), {recursive: true});
        fs.writeFileSync(path.join(dir, 'packages', `${v.name}-${v.version}.zip`), v.content);
      }
    }

    const options = extra => ({satisOutputDir: dir, packagesDir: path.join(dir, 'packages'), repoUrl: REPO_URL, ...extra});

    it('checks versions without an archive by their metadata', async () => {
      const published = row();
      const stamped = sut.formatTime(new Date());
      writeBuild([
        {name: 'acme/alpha', version: '1.0.0', content: null, shasum: published.sha1},
        {name: 'acme/alpha', version: '2.0.0', content: 'alpha 2.0.0', time: stamped},
      ]);

      await expect(sut.verifyBuild([published], options())).rejects.toThrow(/ENOENT/);
      const results = await sut.verifyBuild([published], options({incremental: true}));

      expect(statusOf(results, 'acme/alpha', '1.0.0')).toBe(STATUS.UNCHANGED);
      expect(statusOf(results, 'acme/alpha', '2.0.0')).toBe(STATUS.NEW);
      expect(sut.gateFailures(results)).toEqual([]);
      expect(sut.nextRows(results).map(r => [r.version, r.sha256])).toEqual([['1.0.0', ''], ['2.0.0', sha256('alpha 2.0.0')]]);
    });

    it('fails a version without an archive that is not an unchanged published version', async () => {
      const published = row();
      writeBuild([
        {name: 'acme/alpha', version: '1.0.0', content: null, shasum: published.sha1, extra: {require: {'acme/evil': '*'}}},
        {name: 'acme/alpha', version: '2.0.0', content: null, shasum: sha1('x'), time: sut.formatTime(new Date())},
      ]);

      const results = await sut.verifyBuild([published], options({incremental: true}));

      expect(results.find(r => r.entry.version === '1.0.0').problems).toEqual([expect.stringMatching(/^metadata-sha256/)]);
      expect(results.find(r => r.entry.version === '2.0.0').problems).toEqual(['new version has no archive in the build']);
    });

    it('accepts an alias repointed at a version replacing it that is only in the metadata', async () => {
      const aliasOld = await zipOf({name: 'magento/module-a', type: 'metapackage', version: '100.0.1', require: {'mage-os/module-a': '1.0.0'}});
      const aliasNew = await zipOf({name: 'magento/module-a', type: 'metapackage', version: '100.0.1', require: {'mage-os/module-a': '2.0.0'}});
      const rows = [
        row({name: 'magento/module-a', version: '100.0.1', sha1: sha1(aliasOld)}),
        row({name: 'mage-os/module-a', version: '2.0.0'}),
      ];
      writeBuild([
        {name: 'mage-os/module-a', version: '2.0.0', content: null, shasum: rows[1].sha1, extra: {replace: {'magento/module-a': '100.0.1'}}},
        {name: 'magento/module-a', version: '100.0.1', content: aliasNew},
      ]);
      rows[1]['metadata-sha256'] = sut.metadataSha256({name: 'mage-os/module-a', version: '2.0.0', replace: {'magento/module-a': '100.0.1'}});

      const results = await sut.verifyBuild(rows, options({incremental: true, allowAliasRepoint: true}));

      expect(statusOf(results, 'magento/module-a', '100.0.1')).toBe(STATUS.REPOINTED);
      expect(sut.gateFailures(results)).toEqual([]);
    });
  });
});
