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
});
