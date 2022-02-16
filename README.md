# Mage-OS Mirror Repository Generator - JS Edition

Experimental JavaScript implementation for comparison purposes.
This is not intended to go into production, but rather it is for learning purposes.

## Usage

To generate the repository in a directory ./html, run the command.

Mounting the packages directory is optional but will speed up the build a lot if the packages already where generated previously.

```bash
docker run --rm --init -it --user $(id -u):$(id -g) \
  --volume $(pwd)/packages:/packages \
  --volume $(pwd)/html:/build \
  --volume "${COMPOSER_HOME:-$HOME/.composer}:/composer" \
  magece/mirror-repo-js
```

## Building

```bash
docker build -t magece/mirror-repo-js .
```

## TODO

* Avoid satis recreating the already generated archives
  Maybe this requires writing the composer repository JSON data directly without JSON, or maybe it requires
  running a patched version of satis that doesn't try to download, install and dump an archive if it already exists.
  Maybe a smaller satis patch would be to allow the specifying a prefix-url without a `archive` section in the satis.json,
  because it seems like if that is absent, it simply scans the archives it finds in `repositories`.


## Copyright 2022 Vinai Kopp

Distributed under the terms of the 3-Clause BSD Licence.
See the [LICENSE](LICENSE) file for more details.