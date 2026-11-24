/**
 * Magento/* alias metapackage generation for Mage-OS packages.
 *
 * Creates magento/* alias metapackages that require the corresponding mage-os/* packages,
 * allowing third-party extensions requiring magento/* packages to resolve against the
 * Mage-OS repository.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const {compareVersions} = require('./utils');

const stableMtime = '2022-02-22 22:02:22.000Z';

function report() {
  console.log(...arguments);
}

/**
 * Read composer.json from a zip file.
 *
 * @param {string} zipFilePath - Path to the zip file
 * @returns {Promise<Object>} - Parsed composer.json content
 */
async function readComposerJsonFromZip(zipFilePath) {
  const zipData = fs.readFileSync(zipFilePath);
  const zip = await JSZip.loadAsync(zipData);
  const composerJsonFile = zip.file('composer.json');
  if (!composerJsonFile) {
    throw new Error(`No composer.json found in ${zipFilePath}`);
  }
  const composerJsonContent = await composerJsonFile.async('string');
  return JSON.parse(composerJsonContent);
}

/**
 * The package a magento/* alias metapackage points at, or null if the composer.json is anything other
 * than an alias metapackage requiring exactly one package.
 *
 * @param {Object} composer - composer.json content
 * @returns {{name: string, version: string, target: {name: string, version: string}}|null}
 */
function aliasTarget(composer) {
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
 * aliasTarget() of a package version in satis metadata, which adds these keys to the composer.json.
 */
function metadataAliasTarget(version) {
  const {version_normalized, dist, 'published-time': publishedTime, ...composer} = version;
  return aliasTarget(composer);
}

/**
 * Create a magento/* alias metapackage that requires the corresponding mage-os/* package.
 *
 * @param {string} magentoPackageName - The magento/* package name (e.g., 'magento/module-catalog')
 * @param {string} magentoVersion - The magento version for the alias package
 * @param {string} mageOsPackageName - The mage-os/* package name (e.g., 'mage-os/module-catalog')
 * @param {string} mageOsVersion - The mage-os package version to require
 * @param {Object} packageModules - The package-modules module (for archiveFilePath and writePackage)
 * @returns {Promise<Object.<string, string>>} - Map of {aliasPackageName: version}
 */
async function createMagentoAliasPackage(magentoPackageName, magentoVersion, mageOsPackageName, mageOsVersion, packageModules) {
  // Only create aliases for magento/* packages
  if (!magentoPackageName.startsWith('magento/')) {
    return {};
  }

  const composerConfig = {
    name: magentoPackageName,
    description: `Alias metapackage for ${mageOsPackageName}. Allows extensions requiring ${magentoPackageName} to use the Mage-OS equivalent.`,
    type: 'metapackage',
    version: magentoVersion,
    require: {
      [mageOsPackageName]: mageOsVersion
    }
  };

  const files = [{
    filepath: 'composer.json',
    mtime: new Date(stableMtime),
    contentBuffer: Buffer.from(JSON.stringify(composerConfig, null, 2), 'utf8'),
    isExecutable: false
  }];

  const packageFilepath = packageModules.archiveFilePath(magentoPackageName, magentoVersion);

  // Don't overwrite if package already exists (e.g., from mirror builds)
  if (!fs.existsSync(packageFilepath)) {
    await packageModules.writePackage(packageFilepath, files);
    return {[magentoPackageName]: magentoVersion};
  }

  return {};
}

/**
 * The highest mage-os/* package version replacing each magento/* package version.
 *
 * @param {Array<Object>} composers - composer.json contents of the built mage-os/* packages
 * @returns {Map<string, {magentoName: string, magentoVersion: string, mageOsName: string, mageOsVersion: string}>}
 *   keyed by "magentoName:magentoVersion"
 */
function newestReplacers(composers) {
  const replacers = new Map();
  for (const composer of composers) {
    if (!composer.replace || typeof composer.replace !== 'object') {
      continue;
    }
    for (const [magentoName, magentoVersion] of Object.entries(composer.replace)) {
      if (!magentoName.startsWith('magento/')) {
        continue;
      }
      const key = `${magentoName}:${magentoVersion}`;
      const existing = replacers.get(key);
      if (!existing || compareVersions(composer.version, existing.mageOsVersion) > 0) {
        replacers.set(key, {magentoName, magentoVersion, mageOsName: composer.name, mageOsVersion: composer.version});
      }
    }
  }
  return replacers;
}

/**
 * Generate magento/* alias metapackages by scanning all built mage-os/* packages.
 * Reads each package's composer.json to extract the replace entries and creates
 * corresponding alias packages. When multiple mage-os versions replace the same
 * magento version, the highest mage-os version wins.
 *
 * With the metadata of an incremental build's base, the packages in it count as built, and only aliases
 * that are not in it or that point at an older version are written.
 *
 * @param {string} archiveDir - The package output directory
 * @param {Object} packageModules - The package-modules module (for archiveFilePath and writePackage)
 * @param {Array<Object>|null} baseVersions - Package versions of the base metadata
 * @returns {Promise<Object.<string, string>>} - Map of created aliases {name: version}
 */
async function generateAliasesFromBuiltPackages(archiveDir, packageModules, baseVersions = null) {
  const mageosDir = path.join(archiveDir, 'mage-os');

  if (!fs.existsSync(mageosDir)) {
    console.log(`No mage-os packages directory found at ${mageosDir}`);
    return {};
  }

  const zipFiles = fs.readdirSync(mageosDir)
    .filter(file => file.endsWith('.zip'))
    .map(file => path.join(mageosDir, file));

  console.log(`Scanning ${zipFiles.length} mage-os packages for alias generation...`);

  const composers = [];
  for (const zipPath of zipFiles) {
    try {
      composers.push(await readComposerJsonFromZip(zipPath));
    } catch (error) {
      report(`  Warning: Failed to read ${zipPath}: ${error.message || error}`);
    }
  }

  const published = new Map();
  for (const version of baseVersions || []) {
    if (version.name.startsWith('mage-os/')) {
      composers.push(version);
    } else if (version.name.startsWith('magento/')) {
      published.set(`${version.name}:${version.version}`, version);
    }
  }

  // Create alias packages for each winning candidate
  const aliasPackages = {};

  for (const candidate of newestReplacers(composers).values()) {
    const {magentoName, magentoVersion, mageOsName, mageOsVersion} = candidate;

    const existing = published.get(`${magentoName}:${magentoVersion}`);
    if (existing) {
      const alias = metadataAliasTarget(existing);
      if (!alias || (alias.target.name === mageOsName && alias.target.version === mageOsVersion)) {
        continue;
      }
    }

    try {
      const created = await createMagentoAliasPackage(
        magentoName,
        magentoVersion,
        mageOsName,
        mageOsVersion,
        packageModules
      );
      Object.assign(aliasPackages, created);

      if (Object.keys(created).length > 0) {
        report(`  Created alias: ${magentoName}:${magentoVersion} -> ${mageOsName}:${mageOsVersion}`);
      }
    } catch (error) {
      report(`  Warning: Failed to create alias for ${magentoName}: ${error.message || error}`);
    }
  }

  console.log(`Created ${Object.keys(aliasPackages).length} magento/* alias packages.`);
  return aliasPackages;
}

module.exports = {
  aliasTarget,
  createMagentoAliasPackage,
  generateAliasesFromBuiltPackages,
  metadataAliasTarget,
  newestReplacers,
  readComposerJsonFromZip
};
