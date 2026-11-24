'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const packageModules = require('../../src/package-modules');
const {generateAliasesFromBuiltPackages, metadataAliasTarget, newestReplacers, readComposerJsonFromZip} = require('../../src/package-aliases');

describe('newestReplacers', () => {
  const replacer = (name, version, replace) => ({name, version, replace});

  it('picks the highest mage-os version replacing each magento version', () => {
    const replacers = newestReplacers([
      replacer('mage-os/module-a', '1.0.0', {'magento/module-a': '100.0.1'}),
      replacer('mage-os/module-a', '1.10.0', {'magento/module-a': '100.0.1'}),
      replacer('mage-os/module-a', '1.2.0', {'magento/module-a': '100.0.1'}),
      replacer('mage-os/module-a', '2.0.0', {'magento/module-a': '100.0.2'}),
    ]);

    expect([...replacers.entries()]).toEqual([
      ['magento/module-a:100.0.1', {magentoName: 'magento/module-a', magentoVersion: '100.0.1', mageOsName: 'mage-os/module-a', mageOsVersion: '1.10.0'}],
      ['magento/module-a:100.0.2', {magentoName: 'magento/module-a', magentoVersion: '100.0.2', mageOsName: 'mage-os/module-a', mageOsVersion: '2.0.0'}],
    ]);
  });

  it('ignores packages without replace and replaced packages outside the magento vendor', () => {
    const replacers = newestReplacers([
      {name: 'mage-os/module-b', version: '1.0.0'},
      replacer('mage-os/module-c', '1.0.0', {'acme/module-c': '1.0.0'}),
    ]);
    expect(replacers.size).toBe(0);
  });
});

describe('metadataAliasTarget', () => {
  const alias = (extra = {}) => ({
    name: 'magento/module-a',
    version: '100.0.1',
    version_normalized: '100.0.1.0',
    dist: {type: 'zip', url: 'https://repo.example.com/packages/magento/module-a-100.0.1.zip', shasum: 'abc'},
    require: {'mage-os/module-a': '2.0.0'},
    type: 'metapackage',
    description: 'Alias metapackage for mage-os/module-a.',
    'published-time': '2024-05-01T10:00:00+00:00',
    ...extra,
  });

  it('recognises an alias in satis metadata', () => {
    expect(metadataAliasTarget(alias())).toEqual({
      name: 'magento/module-a',
      version: '100.0.1',
      target: {name: 'mage-os/module-a', version: '2.0.0'},
    });
  });

  it('does not take a package with more than the alias for one', () => {
    expect(metadataAliasTarget(alias({autoload: {files: ['x.php']}}))).toBeNull();
  });
});

describe('generateAliasesFromBuiltPackages with base metadata', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-aliases-'));
    packageModules.setArchiveBaseDir(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  async function writeMageOsPackage(version, replace) {
    const zip = new JSZip();
    zip.file('composer.json', JSON.stringify({name: 'mage-os/module-a', version, replace}));
    fs.mkdirSync(path.join(dir, 'mage-os'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'mage-os', `module-a-${version}.zip`), await zip.generateAsync({type: 'nodebuffer'}));
  }

  const published = (name, version, extra) => ({name, version, version_normalized: `${version}.0`, dist: {}, ...extra});
  const publishedAlias = (version, target) => published('magento/module-a', version, {
    type: 'metapackage',
    description: 'Alias metapackage for mage-os/module-a.',
    require: {'mage-os/module-a': target},
  });
  const aliasTargetOf = async version => (
    await readComposerJsonFromZip(path.join(dir, 'magento', `module-a-${version}.zip`))
  ).require['mage-os/module-a'];

  it('writes only the aliases that are new or point at an older version than the newest replacing them', async () => {
    await writeMageOsPackage('3.0.0', {'magento/module-a': '100.0.2'});
    const base = [
      published('mage-os/module-a', '1.0.0', {replace: {'magento/module-a': '100.0.1'}}),
      published('mage-os/module-a', '2.0.0', {replace: {'magento/module-a': '100.0.2'}}),
      published('mage-os/module-a', '2.1.0', {replace: {'magento/module-a': '100.0.3'}}),
      publishedAlias('100.0.1', '1.0.0'),
      publishedAlias('100.0.2', '2.0.0'),
    ];

    const created = await generateAliasesFromBuiltPackages(dir, packageModules, base);

    expect(created).toEqual({'magento/module-a': '100.0.3'});
    expect(fs.readdirSync(path.join(dir, 'magento')).sort()).toEqual(['module-a-100.0.2.zip', 'module-a-100.0.3.zip']);
    expect(await aliasTargetOf('100.0.2')).toBe('3.0.0');
    expect(await aliasTargetOf('100.0.3')).toBe('2.1.0');
  });

  it('never replaces a published package that is no alias', async () => {
    await writeMageOsPackage('3.0.0', {'magento/module-a': '100.0.2'});
    const base = [published('magento/module-a', '100.0.2', {type: 'magento2-module'})];

    expect(await generateAliasesFromBuiltPackages(dir, packageModules, base)).toEqual({});
    expect(fs.existsSync(path.join(dir, 'magento'))).toBe(false);
  });

  it('keeps an alias pointing at a newer published version than the build', async () => {
    await writeMageOsPackage('2.0.1', {'magento/module-a': '100.0.2'});
    const base = [
      published('mage-os/module-a', '3.0.0', {replace: {'magento/module-a': '100.0.2'}}),
      publishedAlias('100.0.2', '3.0.0'),
    ];

    expect(await generateAliasesFromBuiltPackages(dir, packageModules, base)).toEqual({});
  });
});
