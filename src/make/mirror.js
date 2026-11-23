const repo = require('./../repository');
const parseOptions = require('parse-options');
const {setArchiveBaseDir, setPublishedVersions} = require('./../package-modules');
const {readLedger} = require('./../package-ledger');
const {createRefRecorder, readRefs} = require('./../ref-ledger');
const {copyAdditionalPackages, processMirrorInstruction} = require('./../mirror-build-tools');
const {buildConfig: mirrorInstructions} = require('./../build-config/mirror-build-config');
const buildState = require('../type/build-state');


const options = parseOptions(
  `$outputDir $gitRepoDir $repoUrl $ledger $refs $refsOut @fullRebuild @help|h`,
  process.argv
);


if (options.help) {
  console.log(`Build Mage-OS mirror composer packages from github.com/mage-os git repositories.

Usage:
  node src/make/mirror.js [OPTIONS]

Options:
  --outputDir=   Dir to contain the built packages (default: packages)
  --gitRepoDir=  Dir to clone repositories into (default: repositories)
  --repoUrl=     Composer repository URL to use in base package (default: https://repo.mage-os.org/)
  --ledger=      Package ledger; versions in it are not built again
  --refs=        Ref ledger; recorded tags are not read again, and fail the build if they moved
  --refsOut=     File to write the tags this build processed to, for the ref ledger
  --fullRebuild  Build every version and tag, even those in --ledger and --refs
`);
  process.exit(1);
}

const archiveDir = options.outputDir || 'packages';
setArchiveBaseDir(archiveDir);

if (options.gitRepoDir) {
  repo.setStorageDir(options.gitRepoDir);
}

if (options.ledger && !options.fullRebuild) {
  setPublishedVersions(readLedger(options.ledger));
}

const refRecorder = (options.refs || options.refsOut) && createRefRecorder({
  rows: options.refs ? readRefs(options.refs) : [],
  skip: !options.fullRebuild,
  listRemoteTags: repo.listRemoteTags,
  pendingFile: options.refsOut || null,
});

let releaseContext = new buildState({
  composerRepoUrl: options.repoUrl || 'https://mirror.mage-os.org/',
});


(async () => {
  try {
    for (const instruction of mirrorInstructions) {
      await processMirrorInstruction(instruction, releaseContext, refRecorder);
    }
    await copyAdditionalPackages(archiveDir);
  } catch (exception) {
    console.log(exception);
    throw exception
  }
})()
