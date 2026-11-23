# Mage-OS Composer Repository Generator

## Background

This project was started not with the primary goal to go into production, but rather to explore and learn how to build Magento Open Source releases.  
It has evolved to be used in production. However, the intention is to create additional implementations, for example in Rust <https://github.com/mage-os/package-splitter>.  

## Generated composer repositories

The generator is used to generate the following composer repositories:

- https://mirror.mage-os.org
- https://upstream-nightly.mage-os.org
- https://repo.mage-os.org

It can also be used to generate custom mirrors and releases based on Mage-OS.

## Versions generated for mirrors

When generating a mirror composer repository, all packages required to install Magento Open Source 2.3.7-p3 and newer will be created.
This might change in the future.

## Usage

This project provides a docker image to generate a composer package repository.  

Mount the directory to contain the generated files into `/build` while executing the image.  
Usually this will be the DOCUMENT_ROOT of the host serving the composer repo, for example `--volume /var/www/html:/build`.  

### Specifying the build target(s)

This project can generate different types of composer repositories. At the time of writing, the supported build targets are

#### `--target=mirror` (default)

By default, a Magento Open Source mirror repository is generated.

#### `--target=upstream-nightly`

This generates a release of the current development versions of Magento Open Source. This is known as an "upstream nightly" build.

#### `--target=mageos-nightly`

This generates a release of the current development versions of Mage-OS. This is known as a "nightly" build.

#### `--target=release`

This build target requires a number of additional arguments:
* `--mageosRelease=x.x.x` The release version, for example 1.0.0
* `--mageosVendor=mage-os` The composer vendor name for the release. Defaults to `mage-os` 
* `--upstreamRelease=2.4.6-p1` The corresponding Magento Open Source release.


### Caching git repositories

Caching git repos is optional. Without caching, every git repository will be cloned each time the repo is generated. This ensures the latest versions will be used to generate the packages.  
However, cloning large repositories like Magento Open Source takes some time, so it can be beneficial to cache the cloned repository.  

A local directory can be mounted at `/generate-repo/repositories` in order to cache the cloned GitHub repos.  
Be aware that existing git repositories currently will not be updated on subsequent runs. This is mainly useful during development when executing the container image multiple times consecutively.
If you want to update a cached git repo before packages are generated, either delete the cache dir, or run `git fetch --tags` manually before executing the image. 

Example: `--volume "${HOME}/repo-cache:/generate-repo/repositories"`

### Mounting a composer dir

A `~/.composer` directory can be mounted, too, which will allow satis to benefit from existing caches. This doesn't make a big difference though.  
Example: `--volume "${COMPOSER_HOME:-$HOME/.composer}:/composer"`

### Example with docker

To generate the repository in the directory `~/html`, run the following command, replacing `https://mirror.mage-os.org` with the URL of your mirror:

```bash
docker run --rm --init -it --user $(id -u):$(id -g) \
  --volume "$(pwd)/html:/build" \
  --volume "${COMPOSER_HOME:-$HOME/.composer}:/composer" \
  magece/mageos-repo-js:latest  --target=mirror --mirror-base-url=https://mirror.mage-os.org
```

### podman

If you prefer to execute the container with `podman`, you should not specify the `--user` argument, as the in-container root user will automatically map to the current system user.
To generate the repository in `~/html` using podman, run the following command, replacing `https://mirror.mage-os.org` with the URL of your mirror:

```bash
podman run --rm --init -it \
  --volume "$(pwd)/html:/build:z"  \
  --volume "${COMPOSER_HOME:-$HOME/.composer}:/composer:z" \
  magece/mageos-repo-js:latest --mirror-base-url=https://mirror.mage-os.org
```

### Manual generation

It is possible to generate the composer repositories without a container.  
This process can be useful for automation, for example the mage-os composer repositories are built in this way via GitHub actions.  

For this, you'll need nodejs 16, php8-0 (or 7.4), yarn, git and composer.

Also, the [github.com/mage-os/php-dependency-list](https://github.com/mage-os/php-dependency-list) phar executable is expected to be in the PATH.

```sh
curl -L https://github.com/mage-os/php-dependency-list/raw/main/php-classes.phar -o /usr/local/bin/php-classes.phar
chmod +x /usr/local/bin/php-classes.phar
```

Check the corresponding workflows in `.github/workflows` for details on how to run the generation.

## Generating custom releases based on Mage-OS

Currently, the manual generation approach needs to be used to create custom releases.  
Two things are required:

* Specify a custom vendor name using the `--mageosVendor=extreme-commerce` option
* Provide custom meta-package dependency templates in `resource/composer-templates/{vendor-name}/`  
  See the existing ones in `resource/composer-templates/mage-os` for examples.  
  In future it will be possible to specify the composer-templates path with a command line argument.


## Development

Run the test suite:

```bash
npm install
npm test
```

Tests run automatically on pull requests via GitHub Actions.

## Building the docker image

```bash
docker build -t magece/mirror-repo-js .
```

## Package ledger

`resource/ledger/mirror.tsv` and `resource/ledger/release.tsv` record every package version published to
https://mirror.mage-os.org and https://repo.mage-os.org. There is one line per version, with the archive path, its sha1
and sha256, the `metadata-sha256` of the composer.json fields composer resolves with (name, version, type, the links,
suggest, autoload, extra and bin), the `published-time` served to composer, and the source of that time: `build` for versions recorded by a
deploy, or `upstream`, `tag`, `release` and `bootstrap` for versions published before the ledger existed.  
The nightly repositories have no ledger.

The deploy workflow uses the ledger like this:

1. Before satis runs, the `published-time` of every version in the ledger is seeded into the satis output directory.
   Satis keeps those, and stamps every version it has not seen before with the time of the build.
   Composer cooldown policies (`config.policy.cooldown`) depend on that time never changing for a published version.
2. After satis ran, the build is compared to the ledger (the gate). A deploy to a production repository fails if
   - an already published package has different contents, or is missing from the build
   - the `published-time` of an already published version is not the one in the ledger
   - a new version has no `published-time`, or one that is not the time of the build

   New versions are fine. There is no override flag.  
   The one exception is a `magento/*` alias metapackage of the release repository. It may change if it is an alias
   (it replaces a `mage-os/*` package of the same name) and now requires exactly the highest `mage-os/*` version that
   replaces it anywhere in the build. It keeps its `published-time`, and the ledger row gets the new hashes.  
   The differences are listed in the summary of the workflow run.
3. New versions are committed to the ledger before the packages are uploaded.
   If that commit can not be pushed, nothing is deployed.  
   The job building and uploading the packages can not push to this repository. It hands the updated ledger to the
   `record ledger` job of the same workflow run, and waits until the ledger is on the branch.
4. The zips are uploaded first, then the metadata (`include/`, `p2/`, `packages.json`), then the Cloudflare cache is
   purged. Both uploads compare checksums, so a second run sends no unchanged zip. Zips are never deleted from the
   server. The `delete` input only removes stale metadata, after the new `packages.json` is uploaded.

### Incremental production deploys

A production deploy only builds what the ledger does not have, and adds it to the metadata the repository serves:

1. `package-ledger.js base` fetches the live `packages.json` and its include file, and checks that they contain every
   ledger version with the ledger's sha1, `metadata-sha256` and `published-time`, and no other version.
2. The generator skips the versions in the ledger and the tags in the ref ledger. The release build generates the
   `magento/*` aliases from the live metadata and the new packages, and only writes aliases that are new or now point
   at a newer `mage-os/*` version.
3. Satis runs over the new archives only (`--repository-url`), and takes every other version from the live include file.
4. The gate checks the versions that were not built by their metadata, and the new and repointed ones by their archive.

The metadata is byte for byte the same as that of a full build.

Run the workflow with `full_rebuild` to build everything, as before. Do that

- for the first production deploy of a repository, as its live metadata has no `published-time` yet
- when the base metadata check fails. The live metadata then does not match the ledger: a deploy failed after the
  ledger was recorded, someone changed the server, or a CDN served an old copy. A full rebuild uploads metadata that
  matches the ledger again, or fails the gate and shows what differs.
- after fixing the generator for packages it could not build (see the ref ledger below)

A re-run of a failed deploy checks against the ledger of the commit it started from. If the base metadata check of a
re-run fails on versions that are not in the ledger, the failed run already uploaded its metadata. Start a new run
instead, which checks against the ledger the failed run recorded. For a release, leave `mageos_release` empty, as the
guard refuses a published release, and push a missing release tag from the working copies artifact.  
If the live metadata can not be fetched at all, retry the deploy.

Previews always rebuild everything. Only one deploy per target runs at a time, since each one builds on what the
previous one uploaded.

Deploys to the preview repositories use the ledger of the production repository and never change it. They always
rebuild everything, deploy, and then fail the run if anything differs from the ledger, other than the project
packages (they contain the repository URL). A preview of the mirror and of the release repository also runs weekly,
as the test that the build still reproduces what was published.

Checked before anything is built, for deploys with a ledger:

- A production deploy of a `mageos_release` requires `publish_tag`.
- `publish_tag` on a preview repository fails.
- A `mageos_release` that is already in the ledger fails. Published releases are immutable.

Things to know when running the `Build, deploy & check Mirror` and `Build, deploy & check Release` workflows:

- Deploys to a production repository have to be run from the `main` branch, since that is where the ledger is updated.
- If the gate fails, fix the cause. Do not look for a way around it. If a published package has to change or go
  away on purpose, change its row in the ledger with a reviewed pull request, then deploy.
  The same goes for a wrong `published-time`.
- If a deploy fails after the ledger was committed, the release is already in the ledger, so the
  `mageos_release` guard refuses a new run. Re-run the jobs of the failed workflow run instead. A re-run checks out
  the commit the run started from, and the ledger it records is the one already on the branch.
- The release tag is pushed once the ledger is recorded and the packages are deployed, without waiting for the
  installation check. The working copies are kept as a workflow artifact for 90 days, to push a lost tag.

The reusable `deploy.yml` workflow takes these inputs:

| input | default | purpose |
|---|---|---|
| `ledger` | `''` | Name of the ledger file in `resource/ledger`, without `.tsv`. Empty skips all ledger steps |
| `enforce_ledger` | `true` | Fail on violations and record new versions. `false` is for the preview repositories: report, deploy, then fail on differences |
| `delete` | `true` | Remove stale metadata that is not in the build. The release workflow sets `false` |
| `full_rebuild` | `false` | Build every package instead of adding the new ones to the live metadata. Only changes deploys with `enforce_ledger` |

To compare what a repository currently serves against the ledger, run

```sh
node bin/package-ledger.js audit --ledger=resource/ledger/mirror.tsv --repoUrl=https://mirror.mage-os.org/
```

This checks the version list, the sha1 checksums and the download URLs. Add `--checkTimes` to also check the
metadata files composer 2 reads, including each `published-time`.

The `audit package ledger` workflow runs this daily against both production repositories and fails when they
differ from the ledger. It stays red for a repository until its first production deploy with the ledger, because
the live metadata has no `published-time` before that.

### Ref ledger

`resource/ledger/mirror-refs.tsv` and `resource/ledger/release-refs.tsv` record the git tags the packages were built
from: the build instruction, the tag, the commit it pointed at, and a fingerprint of the instruction's configuration.
A deploy that passed the gate records the tags it processed if every version they produced is in the ledger. The
`record ledger` job commits both files.

The generators take these options for it:

- `--ledger=FILE` does not build the versions in the package ledger again.
- `--refs=FILE` does not read the recorded tags again. A recorded tag that moved or was deleted fails the build.
  When the configuration of an instruction changes, all its tags are processed again.
- `--refsOut=FILE` writes the tags the build processed, for `package-ledger.js verify --update --refs --pendingRefs`.
- `--fullRebuild` builds every version and tag; the recorded commits are still checked.

A tag is recorded even if a package of it failed in a way that repeats on the same commit, a missing composer.json
for example. After fixing the generator for such a case, deploy with `full_rebuild` to build those packages.

## Process of building a new mirror release

A new mirror release gets created when Magento releases a new version.  
The process is composed of a series of steps across 3 repositories of the mage-os organization.

### 0. Preliminary check

Before starting, make sure that the new tags are merged into every `mage-os/mirror-*` repository
(eg: https://github.com/mage-os/mirror-magento2).  
In case it’s not, go to [mage-os/infrastructure](http://github.com/mage-os/infrastructure)
and run [Sync magento/ org upstream repositories into mirrors for mage-os distribution](https://github.com/mage-os/infrastructure/actions/workflows/sync-upstream-magento.yml)
action (check branch `main` when running it).

### 1. magento2-base-composer-json

- Fork and clone https://github.com/mage-os/magento2-base-composer-json,
  then create a new branch that you'll use to create a pull request. 
- Run the `add-release.sh` script for every release, eg:
  ```sh
  ./add-release.sh 2.4.7-p4
  ./add-release.sh 2.4.6-p9
  ./add-release.sh 2.4.5-p11
  ./add-release.sh 2.4.4-p12
  ```
- Add, commit and push all the newly created files.

For a practical example [check this PR](https://github.com/mage-os/magento2-base-composer-json/pull/7).

### 2. github-actions

- Fork and clone https://github.com/mage-os/github-actions,
  then create a new branch that you'll use to create a pull request.
- Update the supported versions matrix editing
  [src/versions/magento-open-source/individual.json](https://github.com/mage-os/github-actions/blob/main/supported-version/src/versions/magento-open-source/individual.json).  
  Remember that, when inserting a new version like 2.4.8-p2, you´ll have to change the _end of life_
  date of the previous version (2.4.6-p1) to _the same day_ of the release date of the next version.
  [Check this example commit](https://github.com/mage-os/github-actions/pull/295/files).
- Check if `magento-open-source/composite.json` needs updating
  (it only happens when a new "non patch" release is published, like 2.4.9).
- Now "build" the project with
  - In the root of the project: `npm install`
  - In the supported-version folder: `npm run build`
- Edit `src/kind/get-currently-supported.spec.ts`
- Run `npm run test` and make sure that all tests are green.
- Commit, push and open a PR on mage-os/github-actions.

For a practical example [check this PR](https://github.com/mage-os/github-actions/pull/262).

### 3. generate-mirror-repo-js

- Fork and clone https://github.com/mage-os/generate-mirror-repo-js,
  then create a new branch that you'll use to create a pull request.
- Copy all the `composer.json` files for all releases with something like
  ```sh
  cp ../mageos-magento2-base-composer-json/2.4.7-p4/magento2-base/composer.json resource/history/magento/magento2-base/2.4.7-p4.json
  cp ../mageos-magento2-base-composer-json/2.4.7-p4/product-community-edition/composer.json resource/history/magento/product-community-edition/2.4.7-p4.json
  cp ../mageos-magento2-base-composer-json/2.4.7-p4/project-community-edition/composer.json resource/history/magento/project-community-edition/2.4.7-p4.json
  ```
- "Build" the mirror with  
  `rm -rf repositories; node src/make/mirror.js --outputDir=build`
- Download all missing packages with  
  `./bin/download-missing-packages-from-repo-magento-com.php project-community-edition/composer.lock build resource/additional-packages`
- Commit and push the new files in `resource`.

When creating the PR on `generate-mirror-repo-js`, in order for all the checks to run,
the PR will have to be merged on a development branch.
Then go to the _actions_ for this repo:  and run the
[build, deploy & check mirror](https://github.com/mage-os/generate-mirror-repo-js/actions/workflows/build-upstream-mirror.yml)
selecting the new dev branch and the rest of the parameters as shown in this image:  
<img width="323" src="https://github.com/user-attachments/assets/31eb1eaf-5c2a-4d0b-8475-9e9f7c9239a8" />

For a practical example [check this PR](https://github.com/mage-os/generate-mirror-repo-js/pull/191)
and [this second one to merge the temporary dev branch into `main`](https://github.com/mage-os/generate-mirror-repo-js/pull/194).

## Process of building a new Mage-OS release

When deciding on a new version number for a Mage-OS release, 
see [our version numbering RFC](https://github.com/mage-os/mageos-magento2/issues/138#event-18190625013).

### 0. Preliminary check

First we need to make sure that all `mageos-` have been updated with latest changes from upstream, we can force the updates with:

- Go to this link:  https://github.com/orgs/mage-os/repositories?q=fork%3Atrue+archived%3Afalse+mageos-
- Click on every repository and, for every repository
- Click the "Actions" tab
- Run the merge-upstream-changes action

Then, for every repo, we have to merge every development branch into our `release/1.x`.  
At the moment we don't have an automated process to do that, but you can check https://github.com/mage-os/github-actions/pull/284 in order to generate the list of commands to do that.  
Note that, after creating all the PRs for every repo, if they don't have any conflicts, they should be merged as they are. But in case they have conflicts, then you should close the PR and manually re-create it via a forked repository in your personal account.

### 1. github-actions

- Fork and clone https://github.com/mage-os/github-actions,
  then create a new branch that you'll use to create a pull request.
- Update the supported versions matrix editing
  [src/versions/mage-os/individual.json](https://github.com/mage-os/github-actions/blob/main/supported-version/src/versions/mage-os/individual.json).  
  Remember that, when inserting a new version like 1.0.6, you´ll have to change the _end of life_
  date of the previous version (1.0.5) to _one day earlier_ of the release date of the next version.
  [Check this example commit](https://github.com/mage-os/github-actions/pull/263/commits/79c0bf654462288ccff7aae572b3a24e89e3256b)
- Check if `mage-os/composite.json` needs updating.
- Now "build" the project with
  - In the root of the project: `npm install`
  - In the supported-version folder: `npm run build`
- Edit `src/kind/get-currently-supported.spec.ts`
- Run `npm run test` and make sure that all tests are green.
- Commit, push and open a PR on mage-os/github-actions.

For a practical example [check this PR](https://github.com/mage-os/github-actions/pull/263).

### 2. Generate a test release

Execute the [Build, deploy & check Release](https://github.com/mage-os/generate-mirror-repo-js/actions/workflows/build-mageos-release.yml)
on the [generate-mirror-repo-js](https://github.com/mage-os/generate-mirror-repo-js), use these parameters as reference:

<img width="309" src="https://github.com/user-attachments/assets/34e2d5cf-175b-4f7a-98c4-26d2fc460e9e" />

**Important**:
- select the "preview" URL/folder in the first two combobox
- fill the version numbers and **do not** check the "push new release tag to repos"

After the workflow has finished, you can go https://preview-repo.mage-os.org and check that everything is ok, you should also
install the newly generated version with `composer create-project --repository-url=https://preview-repo.mage-os.org/ mage-os/project-community-edition`
and check that everything is ok before tagging the official release.


### 3. Generate the official release

Execute the [Build, deploy & check Release](https://github.com/mage-os/generate-mirror-repo-js/actions/workflows/build-mageos-release.yml)
on the [generate-mirror-repo-js](https://github.com/mage-os/generate-mirror-repo-js), use these parameters as reference:

<img width="310" src="https://github.com/user-attachments/assets/e6ae22f7-ad77-4017-a9ac-74224e14b82b" />

**Important**:
- select the production URL/folder in the first two combobox (the ones without the "preview" prefix)
- fill the version numbers and check the "push new release tag to repos"

After the workflow has finished, you can go https://repo.mage-os.org and check that everything is ok, you should also
install the newly generated version with `composer create-project --repository-url=https://repo.mage-os.org/ mage-os/project-community-edition`
before announcing the release.

### 3. Update generate-mirror-repo-js

- Fork and clone https://github.com/mage-os/generate-mirror-repo-js,
  then create a new branch that you'll use to create a pull request.
- Create `resource/history/mage-os/product-community-edition/VERSIONNUMBER.js` and `resource/history/mage-os/project-community-edition/VERSIONNUMBER.js`
  simply copying the previous ones and updating the numbering inside. Also, check
  [product-community-edition/dependencies-template.json](https://github.com/mage-os/generate-mirror-repo-js/blob/main/resource/composer-templates/mage-os/product-community-edition/dependencies-template.json)
  and [project-community-edition/dependencies-template.json](https://github.com/mage-os/generate-mirror-repo-js/blob/main/resource/composer-templates/mage-os/project-community-edition/dependencies-template.json)
  in case there are new lines that should also be added.
- Install the newly released version with `composer create-project --repository-url=https://repo.mage-os.org/ mage-os/project-community-edition`
- Create `resource/history/mage-os/magento2-base/VERSIONNUMBER.js` copying the base composer.json file
  (from `project-community-edition/vendor/mage-os/magento2-base/composer.json` folder).
- Create a PR with only the thre json files [like this one](https://github.com/mage-os/generate-mirror-repo-js/pull/196).

### 4. Announce the release

- Go to https://github.com/mage-os/mageos-magento2/tags and open the new tag
- Click 'Create release from tag' to create a GitHub release
- Update the release info based on the Mage-OS pull requests and contributors ([see an example](https://github.com/mage-os/mageos-magento2/releases/tag/1.0.5))
- Create a Wordpress update post on mage-os.org, based on [an existing release post](https://mage-os.org/releases/release-mage-os-distribution-1-0-5/), with the new release info incorporated.
- Share the new release info on Discord #announcements and LinkedIn.

## Copyright 2022 Vinai Kopp, Mage-OS

Distributed under the terms of the 3-Clause BSD Licence.
See the [LICENSE](LICENSE) file for more details.
