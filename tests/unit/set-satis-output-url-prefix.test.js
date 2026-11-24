'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawnSync} = require('child_process');

const CLI = path.join(__dirname, '../../bin/set-satis-output-url-prefix.js');
const REPO_URL = 'https://repo.example.com/';
const TIME = '2024-05-01T10:00:00+00:00';
const sha1 = content => crypto.createHash('sha1').update(content).digest('hex');
const satisJson = data => JSON.stringify(data, null, 4) + '\n';

describe('bin/set-satis-output-url-prefix.js', () => {
  let dir;
  let build;
  let satisHash;
  let satisInclude;

  const run = () => spawnSync(process.execPath, [CLI, `--satisOutputDir=${build}`, `--repoUrl=${REPO_URL}`], {encoding: 'utf8'});
  const read = file => fs.readFileSync(path.join(build, file), 'utf8');
  const readTree = () => Object.fromEntries(
    fs.readdirSync(build, {recursive: true})
      .filter(file => fs.statSync(path.join(build, file)).isFile())
      .map(file => [file, read(file)])
  );
  const includeName = () => Object.keys(JSON.parse(read('packages.json')).includes)[0];

  // Satis dumps the versions it takes from an include file with published-time before dist
  const fromInclude = {
    name: 'acme/alpha',
    version: '1.0.0',
    version_normalized: '1.0.0.0',
    'published-time': TIME,
    dist: {type: 'zip', url: `${REPO_URL}packages/acme/alpha-1.0.0.zip`, shasum: 'a'},
    authors: [{name: 'Jörg Weller'}],
  };
  const fromZip = outputDir => ({
    name: 'acme/alpha',
    version: '1.1.0',
    version_normalized: '1.1.0.0',
    dist: {type: 'zip', url: `${outputDir}/packages/acme/alpha-1.1.0.zip`, shasum: 'b'},
    description: 'Ships a/b.php',
    'published-time': TIME,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satis-output-url-prefix-'));
    build = path.join(dir, 'build');
    fs.mkdirSync(path.join(build, 'include'), {recursive: true});
    fs.mkdirSync(path.join(build, 'p2', 'acme'), {recursive: true});
    const include = satisJson({packages: {'acme/alpha': {'1.0.0': fromInclude, '1.1.0': fromZip(build)}}});
    satisHash = sha1(include);
    satisInclude = `include/all$${satisHash}.json`;
    fs.writeFileSync(path.join(build, satisInclude), include);
    fs.writeFileSync(path.join(build, 'packages.json'), satisJson({
      packages: [],
      includes: {[satisInclude]: {sha1: satisHash}},
      'metadata-url': '/p2/%package%.json',
      'available-packages': ['acme/alpha'],
    }));
    fs.writeFileSync(path.join(build, 'p2/acme/alpha.json'), satisJson({packages: {'acme/alpha': [fromInclude, fromZip(build)]}}));
    fs.writeFileSync(path.join(build, 'p2/acme/alpha~dev.json'), satisJson({packages: {'acme/alpha': []}}));
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('puts published-time last in every version and keeps the order of the other keys', () => {
    expect(run().status).toBe(0);
    const keys = ['name', 'version', 'version_normalized', 'dist', 'authors', 'published-time'];
    const zipKeys = ['name', 'version', 'version_normalized', 'dist', 'description', 'published-time'];
    const include = JSON.parse(read(includeName())).packages['acme/alpha'];
    const p2 = JSON.parse(read('p2/acme/alpha.json')).packages['acme/alpha'];
    expect([Object.keys(include['1.0.0']), Object.keys(include['1.1.0'])]).toEqual([keys, zipKeys]);
    expect(p2.map(Object.keys)).toEqual([keys, zipKeys]);
    expect(p2[1].dist.url).toBe(`${REPO_URL}packages/acme/alpha-1.1.0.zip`);
  });

  it('names the include file by the sha1 of its final contents in the format of satis', () => {
    const packagesJson = read('packages.json');
    expect(run().status).toBe(0);
    const hash = sha1(read(includeName()));
    expect(includeName()).toBe(`include/all$${hash}.json`);
    expect(read('packages.json')).toBe(packagesJson.replaceAll(satisHash, hash));
    expect(fs.existsSync(path.join(build, satisInclude))).toBe(false);
    expect(fs.readdirSync(path.join(build, 'include'))).toEqual([`all$${hash}.json`]);
  });

  it('changes nothing when run again', () => {
    expect(run().status).toBe(0);
    const first = readTree();
    expect(run().status).toBe(0);
    expect(readTree()).toEqual(first);
  });

  it('writes unicode and slashes unescaped, like satis', () => {
    expect(run().status).toBe(0);
    for (const file of [includeName(), 'p2/acme/alpha.json']) {
      expect(read(file)).toContain('"name": "Jörg Weller"');
      expect(read(file)).toContain('"description": "Ships a/b.php"');
      expect(read(file)).toContain(`"url": "${REPO_URL}packages/acme/alpha-1.1.0.zip"`);
    }
  });
});
