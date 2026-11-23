const fs = require('fs');
const {pipeline} = require('stream/promises');
const repo = require('./repository');
const {isVersionGreaterOrEqual} = require('./utils');
const zip = require('jszip');
const {
  createPackagesForRef,
  createPackageForRef,
  createMetaPackageFromRepoDir,
  archiveFilePath,
  createComposerJsonOnlyPackage,
  isPublished,
  isPublishedArchive
} = require('./package-modules');
const repositoryBuildDefinition = require('./type/repository-build-definition');
const packageDefinition = require('./type/package-definition');
const packageReplacement = require('./type/package-replacement');
const buildState = require('./type/build-state');


/**
 *
 * @param {String} url
 * @param {String} fromTag
 * @param {Array<String>} skipTags
 * @param {Object|null} refs Recorded tags of the instruction, see createRefRecorder()
 * @returns {Promise<Array<String>>}
 */
async function listTagsFrom(url, fromTag, skipTags, refs = null) {
  return (await repo.listTags(url))
    .filter(tag => isTagToBuild(tag, fromTag, skipTags))
    .filter(tag => !(refs && refs.isRecorded(tag)));
}

function isTagToBuild(tag, fromTag, skipTags) {
  return isVersionGreaterOrEqual(tag, fromTag) && (skipTags && skipTags[tag] ? skipTags[tag]() : true);
}

/**
 * @param {String} archiveDir
 */
async function copyAdditionalPackages(archiveDir) {
  const dir = `${__dirname}/../resource/additional-packages`;
  const dest = `${archiveDir}/additional`

  if (fs.existsSync(dir)) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, {recursive: true});

    fs.readdir(dir, async (err, files) => {
      if (err) {
        console.log('' + err);
        return;
      }
      const archives = [];
      for (const file of (files || []).filter(file => file.slice(-4) === '.zip')) {
        if (! fs.existsSync(`${dest}/${file}`) && ! await isPublishedArchive(`additional/${file}`, `${dir}/${file}`)) {
          archives.push(file);
        }
      }
      console.log(`Copying ${archives.length} additional archive(s) into build directory.`);
      archives.map(file => {
        fs.copyFile(`${dir}/${file}`, `${dest}/${file}`, err => err && console.log(err))
      })
    })
  }
}

/**
 * @param {repositoryBuildDefinition} instruction
 * @param {packageDefinition} pkg
 * @returns {Array<String>} Packaged tags
 */
async function createMetaPackagesFromRepoDir(instruction, pkg, refs = null) {
  const tags = await listTagsFrom(instruction.repoUrl, instruction.fromTag, instruction.skipTags, refs);
  console.log(`Versions to process: ${tags.join(', ')}`);
  const built = [];
  for (const tag of tags) {
    console.log(`Processing ${tag}`);

    let release = new buildState({
      ref: tag,
      fallbackVersion: tag,
      dependencyVersions: (instruction.fixVersions?.[tag] ?? {})
    });

    try {
      const packages = await createMetaPackageFromRepoDir(
        instruction,
        pkg,
        release
      );
      refs && refs.built(tag, packages);
      built.push(tag);
    } catch (exception) {
      refs && refs.failed(tag, exception);
      console.log(exception.message || exception);
    }
  }
  return built;
}

/**
 * @param {repositoryBuildDefinition} instruction
 * @param {packageDefinition} pkg
 * @returns {Array<String>} Packaged tags
 */
async function createPackagesSinceTag(instruction, pkg, refs = null) {
  const tags = await listTagsFrom(instruction.repoUrl, instruction.fromTag, instruction.skipTags, refs);
  console.log(`Versions to process: ${tags.join(', ')}`);
  const built = [];
  for (const tag of tags) {
    console.log(`Processing ${tag}`);

    let release = new buildState({
      ref: tag,
      dependencyVersions: (instruction.fixVersions?.[tag] ?? {})
    });

    try {
      const packages = await createPackagesForRef(
        instruction,
        pkg,
        release
      );
      refs && refs.built(tag, packages);
      built.push(tag)
    } catch (exception) {
      refs && refs.failed(tag, exception);
      console.log(exception.message || exception);
    }
  }
  return built;
}

/**
 * @param {repositoryBuildDefinition} instruction
 * @param {packageDefinition} pkg
 * @returns {Array<String>} Packaged tags
 */
async function createPackageSinceTag(instruction, pkg, refs = null) {
  const tags = await listTagsFrom(instruction.repoUrl, instruction.fromTag, instruction.skipTags, refs);
  const built = [];

  console.log(`Versions to process: ${tags.join(', ')}`);

  for (const tag of tags) {
    console.log(`Processing ${tag}`);

    // Note: if the composerJsonFile ends with the "template.json" the composer dependencies will be calculated
    // This is only used for non-mirror magento2-base-package builds
    pkg.composerJsonFile = null;
    if (pkg.composerJsonPath && pkg.composerJsonPath.length) {
      let composerJsonFile = pkg.composerJsonPath
        .replace('composer-templates', 'history')
        .replace('template.json', `${tag}.json`);
      composerJsonFile = fs.existsSync(composerJsonFile)
        ? composerJsonFile
        : pkg.composerJsonPath;

      pkg.composerJsonFile = composerJsonFile;
    }

    let release = new buildState({
      ref: tag,
      dependencyVersions: (instruction.fixVersions?.[tag] ?? {})
    });

    try {
      const packages = await createPackageForRef(
        instruction,
        pkg,
        release
      );
      refs && refs.built(tag, packages);
      built.push(tag);
    } catch (exception) {
      refs && refs.failed(tag, exception);
      console.log(exception.message || exception);
    }
  }
  return built;
}

/**
 * @param {packageReplacement} pkg
 * @return {void}
 */
async function replacePackageFiles(pkg) {
  if (isPublished(pkg.name, pkg.version)) {
    return;
  }
  const packageFilePath = archiveFilePath(pkg.name, pkg.version);
  if (!fs.existsSync(packageFilePath)) {
    throw {message: `Could not find archive ${packageFilePath} for replacement: ${pkg.name}:${pkg.version}.`};
  }

  const contents = await zip.loadAsync(await fs.promises.readFile(packageFilePath));

  for (const file of pkg.files) {
    const replacementFilePath = `${__dirname}/../resource/replace/${pkg.name}/${pkg.version}/${file}`;
    if (!fs.existsSync(replacementFilePath)) {
      throw {message: `Replacement file does not exist: ${replacementFilePath}`};
    }
    contents.file(
      file,
      fs.readFileSync(replacementFilePath),
      {date: new Date('2022-02-22 22:02:22.000Z'), unixPermissions: '644'}
    );
  }

  const stream = contents.generateNodeStream({streamFiles: false, platform: 'UNIX'});
  await pipeline(stream, fs.createWriteStream(packageFilePath));
}

/**
 * @param {repositoryBuildDefinition} instruction
 * @param {Object} metapackage
 * @param {buildState} releaseContext
 * @param {Object|null} refs
 * @returns {Array<String>} Packaged tags
 */
async function createMetaPackagesSinceTag(instruction, metapackage, releaseContext, refs = null) {
  const packageName = `${instruction.vendor}/${metapackage.name}`;
  const tags = await listTagsFrom(
    instruction.repoUrl,
    metapackage.fromTag || instruction.fromTag,
    instruction.skipTags,
    refs
  );
  console.log(`Versions to process for metapackage ${packageName}: ${tags.join(', ')}`);

  for (const tag of tags) {
    console.log(`Processing ${tag}`);
    let release = new buildState({
      ref: tag,
      composerRepoUrl: releaseContext.composerRepoUrl,
      fallbackVersion: tag,
      dependencyVersions: (instruction.fixVersions?.[tag] ?? {})
    });

    await createComposerJsonOnlyPackage(
      instruction,
      release,
      packageName,
      tag,
      async composerConfig => {
        if (metapackage.transform) {
          for (const fn of metapackage.transform) {
            composerConfig = await fn(composerConfig, instruction, metapackage, release);
          }
        }

        if (instruction.transform[packageName]) {
          for (const fn of instruction.transform[packageName]) {
            composerConfig = await fn(composerConfig, instruction, metapackage, release);
          }
        }

        return composerConfig;
      }
    );
    refs && refs.built(tag, {[packageName]: tag});
  }
  return tags;
}

/**
 * Whether every tag the instruction would build is recorded, judged by the remote, so the repository
 * does not even have to be cloned.
 *
 * @param {repositoryBuildDefinition} instruction
 * @param {Object} refs
 */
function isFullyRecorded(instruction, refs) {
  const fromTags = [instruction.fromTag, ...instruction.extraMetapackages.map(metapackage => metapackage.fromTag || instruction.fromTag)];
  return refs.remoteTags()
    .filter(tag => fromTags.some(fromTag => isTagToBuild(tag, fromTag, instruction.skipTags)))
    .concat(instruction.extraRefToRelease.map(extra => extra.release))
    .every(tag => refs.isRecorded(tag));
}

/**
 * @param {repositoryBuildDefinition} instruction
 * @param {buildState} releaseContext
 * @param {Object|null} refRecorder Skips recorded tags and records built ones, see createRefRecorder()
 * @returns {Promise<void>}
 */
async function processMirrorInstruction(instruction, releaseContext, refRecorder = null) {
  let tags = [];
  const refs = refRecorder && await refRecorder.forInstruction(instruction, releaseContext.composerRepoUrl);

  if (refs && isFullyRecorded(instruction, refs)) {
    console.log(`All tags of ${instruction.key} are recorded, skipping it`);
    for (const packageReplacement of (instruction.packageReplacements)) {
      await replacePackageFiles(packageReplacement);
    }
    refs.done();
    return;
  }

  await Promise.all(
    instruction.extraRefToRelease
      .filter(extra => !(refs && refs.isRecorded(extra.release)))
      .map(
        extra => repo.createTagForRef(instruction.repoUrl, extra.ref, extra.release, 'Mage-OS Extra Ref', extra.details)
      )
  );

  for (const pkg of (instruction.packageDirs)) {
    console.log(`Packaging ${pkg.label}`);
    tags = await createPackagesSinceTag(instruction, pkg, refs)
    console.log(pkg.label, tags);
  }

  for (const pkg of (instruction.packageIndividual)) {
    console.log(`Packaging ${pkg.label}`);
    tags = await createPackageSinceTag(instruction, pkg, refs);
    console.log(pkg.label, tags);
  }

  for (const pkg of (instruction.packageMetaFromDirs)) {
    console.log(`Packaging ${pkg.label}`);
    tags = await createMetaPackagesFromRepoDir(instruction, pkg, refs);
    console.log(pkg.label, tags);
  }

  for (const packageReplacement of (instruction.packageReplacements)) {
    await replacePackageFiles(packageReplacement);
  }

  for (const metapackage of instruction.extraMetapackages) {
    console.log(`Packaging ${metapackage.name}`);
    tags = await createMetaPackagesSinceTag(instruction, metapackage, releaseContext, refs);
  }

  refs && refs.done();
  repo.clearCache();
}

module.exports = {
  copyAdditionalPackages,
  processMirrorInstruction
}
