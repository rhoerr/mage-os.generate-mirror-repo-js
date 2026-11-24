'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawnSync} = require('child_process');
const ledger = require('../../src/package-ledger');

const CLI = path.join(__dirname, '../../bin/package-ledger.js');
const REPO_URL = 'https://repo.example.com/';
const TIME = '2024-05-01T10:00:00+00:00';
const sha1 = content => crypto.createHash('sha1').update(content).digest('hex');

describe('bin/package-ledger.js', () => {
  let dir;
  let ledgerFile;

  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, `--ledger=${ledgerFile}`], {cwd: dir, encoding: 'utf8'});

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-ledger-cli-'));
    ledgerFile = path.join(dir, 'ledger.tsv');
    ledger.writeLedger(ledgerFile, [{
      name: 'mage-os/product-community-edition',
      version: '2.0.0',
      version_normalized: '2.0.0.0',
      path: 'mage-os/product-community-edition-2.0.0.zip',
      sha1: sha1('published'),
      sha256: '',
      'metadata-sha256': ledger.metadataSha256({name: 'mage-os/product-community-edition', version: '2.0.0'}),
      'published-time': TIME,
      source: 'tag',
    }]);
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  describe('verify', () => {
    beforeEach(() => {
      const name = 'mage-os/product-community-edition';
      const build = path.join(dir, 'build');
      fs.mkdirSync(path.join(build, 'p2', 'mage-os'), {recursive: true});
      fs.mkdirSync(path.join(build, 'packages', 'mage-os'), {recursive: true});
      fs.writeFileSync(path.join(build, 'packages.json'), JSON.stringify({'available-packages': [name]}));
      fs.writeFileSync(path.join(build, 'p2', `${name}.json`), JSON.stringify({packages: {[name]: [{
        name,
        version: '2.0.0',
        version_normalized: '2.0.0.0',
        dist: {type: 'zip', url: `${REPO_URL}packages/${name}-2.0.0.zip`, shasum: sha1('rebuilt')},
        'published-time': TIME,
      }]}}));
      fs.writeFileSync(path.join(build, 'packages', `${name}-2.0.0.zip`), 'rebuilt');
    });

    it('fails on a modified published version', () => {
      const result = run('verify', '--satisOutputDir=build', `--repoUrl=${REPO_URL}`, '--update');
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAILED: 1 already published version(s) modified');
      expect(fs.readFileSync(ledgerFile, 'utf8')).toContain(sha1('published'));
    });

    it('no longer accepts --allowChanges', () => {
      const result = run('verify', '--satisOutputDir=build', `--repoUrl=${REPO_URL}`, '--update', '--allowChanges');
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(ledgerFile, 'utf8')).toContain(sha1('published'));
    });

    it.each([
      ['*/product-community-edition-*', 0],
      ['*/project-community-edition-*', 1],
    ])('as the end-of-run check of a preview with --expectDiff=%s exits %i', (expectDiff, status) => {
      const before = fs.readFileSync(ledgerFile, 'utf8');
      const result = run('verify', '--satisOutputDir=build', `--repoUrl=${REPO_URL}`, '--mode=gate', `--expectDiff=${expectDiff}`);
      expect(result.status).toBe(status);
      expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before);
    });
  });

  describe('verify --update with --pendingRefs', () => {
    const refs = require('../../src/ref-ledger');
    const name = 'mage-os/product-community-edition';
    const commit = 'a'.repeat(40);
    const fingerprint = 'f'.repeat(64);
    let refsFile;
    let pendingFile;

    beforeEach(() => {
      const build = path.join(dir, 'build');
      fs.mkdirSync(path.join(build, 'p2', 'mage-os'), {recursive: true});
      fs.mkdirSync(path.join(build, 'packages', 'mage-os'), {recursive: true});
      fs.writeFileSync(path.join(build, 'packages.json'), JSON.stringify({'available-packages': [name]}));
      fs.writeFileSync(path.join(build, 'p2', `${name}.json`), JSON.stringify({packages: {[name]: ['2.0.0', '2.1.0'].map(version => ({
        name,
        version,
        version_normalized: `${version}.0`,
        dist: {type: 'zip', url: `${REPO_URL}packages/${name}-${version}.zip`, shasum: sha1(version === '2.0.0' ? 'published' : 'new')},
        'published-time': version === '2.0.0' ? TIME : ledger.formatTime(new Date()),
      }))}}));
      fs.writeFileSync(path.join(build, 'packages', `${name}-2.0.0.zip`), 'published');
      fs.writeFileSync(path.join(build, 'packages', `${name}-2.1.0.zip`), 'new');
      refsFile = path.join(dir, 'refs.tsv');
      pendingFile = path.join(dir, 'pending.json');
      refs.writeRefs(refsFile, []);
    });

    const pending = (tag, versions, overrides = {}) => ({instruction: 'magento2', tag, commit, fingerprint, versions, ...overrides});
    const verify = () => run('verify', '--satisOutputDir=build', `--repoUrl=${REPO_URL}`, '--update', `--refs=${refsFile}`, `--pendingRefs=${pendingFile}`);

    it('does not update the ledgers from a packages.json satis did not write', () => {
      fs.writeFileSync(pendingFile, JSON.stringify([pending('2.1.0', [[name, '2.1.0']])]));
      fs.writeFileSync(path.join(dir, 'build', 'packages.json'), JSON.stringify({
        'available-packages': [name],
        repositories: [{type: 'vcs', url: 'https://evil.example.com/repo.git'}],
      }));
      const before = fs.readFileSync(ledgerFile, 'utf8');
      const result = verify();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAILED: packages.json: unexpected repositories');
      expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before);
      expect(refs.readRefs(refsFile)).toEqual([]);
    });

    it('records the tags whose versions are all in the updated ledger', () => {
      fs.writeFileSync(pendingFile, JSON.stringify([
        pending('2.1.0', [[name, '2.1.0']]),
        pending('2.2.0', [[name, '2.2.0']]),
      ]));
      const result = verify();
      expect(result.status).toBe(0);
      expect(refs.readRefs(refsFile).map(row => row.tag)).toEqual(['2.1.0']);
      expect(ledger.readLedger(ledgerFile).map(row => row.version)).toEqual(['2.0.0', '2.1.0']);
    });

    it('changes neither ledger when a recorded tag moved', () => {
      refs.writeRefs(refsFile, [{instruction: 'magento2', tag: '2.0.0', commit, fingerprint}]);
      fs.writeFileSync(pendingFile, JSON.stringify([pending('2.0.0', [[name, '2.0.0']], {commit: 'b'.repeat(40)})]));
      const before = fs.readFileSync(ledgerFile, 'utf8');
      expect(verify().status).toBe(2);
      expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before);
      expect(refs.readRefs(refsFile)[0].commit).toBe(commit);
    });

    it('requires --update and --refs', () => {
      fs.writeFileSync(pendingFile, '[]');
      expect(run('verify', '--satisOutputDir=build', `--repoUrl=${REPO_URL}`, `--pendingRefs=${pendingFile}`).status).toBe(2);
    });
  });

  describe('guard', () => {
    it.each([
      [['--target=production', '--mageosRelease=2.1.0', '--publishTag=true'], 0],
      [['--target=production', '--mageosRelease=', '--publishTag=false'], 0],
      [['--target=preview', '--publishTag=false'], 0],
      [['--target=production', '--mageosRelease=2.1.0', '--publishTag=false'], 1],
      [['--target=preview', '--mageosRelease=2.1.0', '--publishTag=true'], 1],
      [['--target=preview', '--mageosRelease=2.0.0', '--publishTag=false'], 1],
      [['--target=production', '--mageosRelease=2.1.0', '--publishTag='], 2],
      [['--target=staging', '--publishTag=false'], 2],
    ])('with %j exits %i', (args, status) => {
      expect(run('guard', ...args).status).toBe(status);
    });
  });

  describe('base', () => {
    const http = require('http');
    const {execFile} = require('child_process');
    const name = 'mage-os/product-community-edition';
    let server;
    let baseUrl;
    let served;

    beforeEach(async () => {
      const version = {
        name,
        version: '2.0.0',
        version_normalized: '2.0.0.0',
        dist: {type: 'zip', url: `${REPO_URL}packages/${name}-2.0.0.zip`, shasum: sha1('published')},
        'published-time': TIME,
      };
      served = {
        '/packages.json': JSON.stringify({includes: {'include/all$abc.json': {sha1: 'abc'}}}),
        '/include/all$abc.json': JSON.stringify({packages: {[name]: {'2.0.0': version}}}),
      };
      server = http.createServer((request, response) => {
        const file = decodeURIComponent(request.url.split('?')[0]);
        response.writeHead(file in served ? 200 : 404);
        response.end(served[file] || '');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;
    });

    afterEach(async () => {
      await new Promise(resolve => server.close(resolve));
    });

    const base = () => new Promise(resolve => execFile(
      process.execPath,
      [CLI, 'base', `--ledger=${ledgerFile}`, `--repoUrl=${REPO_URL}`, `--baseUrl=${baseUrl}`, '--satisOutputDir=build'],
      {cwd: dir, encoding: 'utf8'},
      (error, stdout) => resolve({status: error ? error.code : 0, stdout})
    ));

    it('writes the live metadata that matches the ledger to the satis output dir', async () => {
      const result = await base();
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'build', 'include', 'all$abc.json'), 'utf8')).toBe(served['/include/all$abc.json']);
      expect(fs.readFileSync(path.join(dir, 'build', 'packages.json'), 'utf8')).toBe(served['/packages.json']);
    });

    it.each([
      ['a stale copy', () => served['/include/all$abc.json'] = JSON.stringify({packages: {}})],
      ['a seed satis did not replace', () => served['/include/all$abc.json'] = JSON.stringify({packages: {[name]: {'2.0.0': {name, version: '2.0.0'}}}})],
    ])('fails on %s and points at full_rebuild', async (_, change) => {
      change();
      const result = await base();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Deploy with full_rebuild');
      expect(fs.existsSync(path.join(dir, 'build'))).toBe(false);
    });

    it('asks for a retry when the metadata can not be fetched', async () => {
      delete served['/include/all$abc.json'];
      const result = await base();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('HTTP 404');
      expect(result.stdout).toContain('Retry');
      expect(fs.existsSync(path.join(dir, 'build'))).toBe(false);
    });
  });
});
