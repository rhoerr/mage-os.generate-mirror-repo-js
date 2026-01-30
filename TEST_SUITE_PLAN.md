# Comprehensive Test Suite Plan

## Executive Summary

This document outlines a comprehensive test suite plan for the Mage-OS Mirror Repository Generator codebase. The project is a Node.js application that generates Magento/Mage-OS composer package archives from git repositories.

### Current Coverage Status
- **Existing Test Files:** 4
- **Estimated Current Coverage:** ~10-15% of business logic
- **Target Coverage Goal:** 80%+ for core business logic, 60%+ overall

---

## Test Categories

### 1. Unit Tests (Pure Functions)
Target: **90%+ coverage**

These functions have no external dependencies and can be tested in isolation.

### 2. Integration Tests (Mocked Dependencies)
Target: **70%+ coverage**

Functions that interact with file system, git, or network but can be tested with mocks.

### 3. End-to-End Tests
Target: **Key workflows covered**

Full workflow tests that verify complete build processes work correctly.

---

## Module-by-Module Test Plan

### 1. `src/utils.js`

**Current Coverage:** Partial (version comparison and mergeBuildConfigs tested)

| Function | Priority | Test Type | Status | Test Cases Needed |
|----------|----------|-----------|--------|-------------------|
| `compareTags()` | High | Unit | ✅ Covered | Edge cases: empty strings, invalid formats |
| `isVersionGreaterOrEqual()` | High | Unit | ✅ Covered | - |
| `isVersionLessOrEqual()` | High | Unit | ✅ Covered | - |
| `isVersionEqual()` | High | Unit | ✅ Covered | - |
| `lastTwoDirs()` | Medium | Unit | ❌ Missing | 5-7 test cases |
| `httpSlurp()` | Low | Integration | ❌ Missing | Mock HTTP, error handling |
| `mergeBuildConfigs()` | High | Unit | ✅ Covered | Additional edge cases |

**New Test Cases for `lastTwoDirs()`:**
```javascript
// tests/utils.test.js additions
describe('lastTwoDirs', () => {
  test('extracts last two directory segments', () => {
    expect(sut.lastTwoDirs('app/code/Magento/Catalog')).toBe('Magento/Catalog');
  });
  test('handles single directory', () => {
    expect(sut.lastTwoDirs('Catalog')).toBe('Catalog');
  });
  test('handles empty string', () => {
    expect(sut.lastTwoDirs('')).toBe('');
  });
  test('uses custom separator', () => {
    expect(sut.lastTwoDirs('app/code/Magento/Catalog', '_')).toBe('Magento_Catalog');
  });
  test('handles trailing slash', () => {
    expect(sut.lastTwoDirs('app/code/')).toBe('app/code');
  });
});
```

---

### 2. `src/package-modules.js` (CRITICAL - Largest Module)

**Current Coverage:** 0%

This is the core module with the most business logic. Requires comprehensive testing.

#### Pure Functions (Unit Tests)

| Function | Priority | Test Cases Needed |
|----------|----------|-------------------|
| `allParentDirs()` | High | 5 cases: nested paths, single file, root file, empty |
| `ltrim()` | Medium | 4 cases: string trim, no match, empty string, full match |
| `rtrim()` | Medium | 4 cases: string trim, no match, empty string, full match |
| `getVersionStability()` | High | 8 cases: dev, alpha, beta, RC, stable, edge cases |
| `archiveFilePath()` | High | 4 cases: relative/absolute base, special chars |
| `isInAdditionalPackages()` | High | 6 cases: exists, not exists, patch versions |
| `chooseNameAndVersion()` | Critical | 8 cases: all version sources, error conditions |

**Recommended Test File: `tests/package-modules.test.js`**

```javascript
// Test structure for package-modules.js
const sut = require('../src/package-modules');

describe('allParentDirs', () => {
  // Access internal via module refactoring or testing exported behavior
});

describe('getVersionStability', () => {
  test('identifies dev versions', () => {
    expect(sut.getVersionStability('dev-master')).toBe('dev');
    expect(sut.getVersionStability('2.4.0-dev')).toBe('dev');
  });
  test('identifies alpha versions', () => {
    expect(sut.getVersionStability('2.4.0-alpha1')).toBe('alpha');
  });
  test('identifies beta versions', () => {
    expect(sut.getVersionStability('2.4.0-beta2')).toBe('beta');
  });
  test('identifies RC versions', () => {
    expect(sut.getVersionStability('2.4.0-rc1')).toBe('RC');
  });
  test('identifies stable versions', () => {
    expect(sut.getVersionStability('2.4.0')).toBe('stable');
    expect(sut.getVersionStability('2.4.0-p1')).toBe('stable');
  });
});

describe('archiveFilePath', () => {
  test('generates correct path for package', () => {
    // Need to mock archiveBaseDir or test via setArchiveBaseDir
  });
});
```

#### Functions Requiring Mocks (Integration Tests)

| Function | Priority | Dependencies to Mock |
|----------|----------|---------------------|
| `readComposerJson()` | High | `repo.readFile` |
| `getComposerJson()` | High | `readComposerJson`, `httpSlurp`, `fs` |
| `setDependencyVersions()` | Critical | None (but complex logic) |
| `determinePackageForRef()` | High | `getComposerJson` |
| `createPackageForRef()` | Critical | `repo.*`, `fs.*`, `JSZip` |
| `createPackagesForRef()` | High | `createPackageForRef` |
| `createMetaPackageFromRepoDir()` | High | `readComposerJson`, `fs` |
| `createMetaPackage()` | High | Multiple |
| `findModulesToBuild()` | Medium | `repo.listFolders` |

**Coverage Goal:** 80% for this module

---

### 3. `src/mirror-build-tools.js`

**Current Coverage:** 0%

| Function | Priority | Test Type | Test Cases |
|----------|----------|-----------|------------|
| `listTagsFrom()` | High | Integration | Filter by fromTag, skipTags |
| `copyAdditionalPackages()` | Medium | Integration | Mock fs operations |
| `createMetaPackagesFromRepoDir()` | Medium | Integration | Full flow with mocks |
| `createPackagesSinceTag()` | Medium | Integration | Full flow with mocks |
| `createPackageSinceTag()` | Medium | Integration | Full flow with mocks |
| `replacePackageFiles()` | High | Integration | ZIP manipulation |
| `processMirrorInstruction()` | High | E2E | Full orchestration |

**Coverage Goal:** 60%

---

### 4. `src/release-build-tools.js`

**Current Coverage:** 0%

#### Pure Functions (Unit Tests)

| Function | Priority | Test Cases Needed |
|----------|----------|-------------------|
| `validateVersionString()` | High | 10 cases: valid/invalid formats |
| `setMageOsVendor()` | High | 4 cases: magento/, other vendors |
| `updateMapFromMagentoToMageOs()` | High | 5 cases: various package maps |
| `updateComposerDepsFromMagentoToMageOs()` | Critical | 8 cases: all dependency types |
| `setMageOsDependencyVersion()` | High | 6 cases: packagist checks, sample-data |
| `updateComposerDepsVersionForMageOs()` | High | Covered by above |
| `updateComposerPluginConfigForMageOs()` | Medium | 4 cases: plugin config scenarios |
| `updateComposerConfigFromMagentoToMageOs()` | Critical | 10 cases: full transformation |

**Recommended Test File: `tests/release-build-tools.test.js`**

```javascript
const sut = require('../src/release-build-tools');

describe('validateVersionString', () => {
  test('accepts valid X.Y format', () => {
    expect(() => sut.validateVersionString('1.0')).not.toThrow();
    expect(() => sut.validateVersionString('2.4')).not.toThrow();
  });
  test('accepts valid X.Y.Z format', () => {
    expect(() => sut.validateVersionString('1.0.0')).not.toThrow();
    expect(() => sut.validateVersionString('2.4.6')).not.toThrow();
  });
  test('accepts versions with suffixes', () => {
    expect(() => sut.validateVersionString('2.4-beta')).not.toThrow();
    expect(() => sut.validateVersionString('2.4.6-p2')).not.toThrow();
    expect(() => sut.validateVersionString('1.2.0-alpha1')).not.toThrow();
  });
  test('rejects invalid versions', () => {
    expect(() => sut.validateVersionString('invalid')).toThrow();
    expect(() => sut.validateVersionString('1')).toThrow();
    expect(() => sut.validateVersionString('1.2.3.4.5')).toThrow();
  });
});

describe('setMageOsVendor', () => {
  test('replaces magento/ prefix with custom vendor', () => {
    expect(sut.setMageOsVendor('magento/module-catalog', 'mage-os'))
      .toBe('mage-os/module-catalog');
  });
  test('does not modify non-magento packages', () => {
    expect(sut.setMageOsVendor('other/package', 'mage-os'))
      .toBe('other/package');
  });
});

describe('updateMapFromMagentoToMageOs', () => {
  test('transforms all magento packages in map', () => {
    const input = {
      'magento/module-a': '^1.0',
      'magento/module-b': '^2.0',
      'other/package': '^3.0'
    };
    const result = sut.updateMapFromMagentoToMageOs(input, 'mage-os');
    expect(result).toEqual({
      'mage-os/module-a': '^1.0',
      'mage-os/module-b': '^2.0',
      'mage-os/package': '^3.0' // Note: other/ also gets transformed
    });
  });
});
```

**Coverage Goal:** 75%

---

### 5. `src/release-branch-build-tools.js`

**Current Coverage:** Partial (calcNightlyBuildPackageBaseVersion, transformVersionsToNightlyBuildVersions tested)

| Function | Priority | Status | Additional Tests |
|----------|----------|--------|------------------|
| `calcNightlyBuildPackageBaseVersion()` | High | ✅ Covered | Edge cases |
| `transformVersionsToNightlyBuildVersions()` | High | ✅ Covered | - |
| `getReleaseDateString()` | Medium | ❌ Missing | Date format verification |
| `addSuffixToVersion()` | Medium | ❌ Missing | 5 test cases |
| `getPackagesForBuildInstruction()` | High | ❌ Missing | Integration test |
| `processBuildInstruction()` | Medium | ❌ Missing | Integration test |

**Additional Tests Needed:**

```javascript
describe('getReleaseDateString', () => {
  test('returns date in YYYYMMDD format', () => {
    const result = sut.getReleaseDateString();
    expect(result).toMatch(/^\d{8}$/);
  });
});
```

**Coverage Goal:** 85%

---

### 6. `src/determine-dependencies.js`

**Current Coverage:** 0%

This module contains the `DependencyAnalyzer` class with complex async logic.

| Method | Priority | Test Type | Notes |
|--------|----------|-----------|-------|
| `DependencyAnalyzer.exists()` | Low | Unit | Simple fs check |
| `createWorkDirPath()` | Medium | Unit | Hash-based path |
| `filterPhpFiles()` | High | Unit | File filtering logic |
| `processFilesInBatches()` | Medium | Unit | Batch processing |
| `setupWorkDir()` | Medium | Integration | Mock fs.cp |
| `runComposerInstall()` | Low | Integration | External command |
| `processPhpFiles()` | Medium | Integration | External tool |
| `findComposerPackages()` | Medium | Integration | External tool |
| `cleanup()` | Medium | Integration | Mock fs.rm |
| `determineSourceDependencies()` | High | Integration | Full flow |

**Recommended Test File: `tests/determine-dependencies.test.js`**

```javascript
const { DependencyAnalyzer } = require('../src/determine-dependencies');

describe('DependencyAnalyzer', () => {
  describe('filterPhpFiles', () => {
    test('filters PHP files from file list', () => {
      const analyzer = new DependencyAnalyzer('/tmp/test');
      const files = [
        { filepath: 'test.php', contentBuffer: Buffer.from('<?php') },
        { filepath: 'test.phtml', contentBuffer: Buffer.from('<html>') },
        { filepath: 'test.js', contentBuffer: Buffer.from('const x = 1') },
        { filepath: 'empty.php', contentBuffer: Buffer.from('') },
      ];
      const result = analyzer.filterPhpFiles(files);
      expect(result).toHaveLength(2);
    });
  });
});
```

**Coverage Goal:** 50% (heavy external dependencies)

---

### 7. `src/repository/shell-git.js`

**Current Coverage:** ~5% (only dirForRepoUrl tested)

| Function | Priority | Test Type | Notes |
|----------|----------|-----------|-------|
| `dirForRepoUrl()` | Medium | Unit | ✅ Partial |
| `fullRepoPath()` | Medium | Unit | ❌ Missing |
| `trimDir()` | Low | Unit | ❌ Missing |
| `validateRefIsSecure()` | Critical | Unit | ❌ Missing - Security! |
| `validateBranchIsSecure()` | Critical | Unit | ❌ Missing - Security! |
| Git operations | Medium | Integration | Mocked git commands |

**Security-Critical Tests (High Priority):**

```javascript
describe('validateRefIsSecure', () => {
  test('rejects refs starting with dash', () => {
    expect(() => validateRefIsSecure('-rf')).toThrow('potentially insecure');
  });
  test('rejects refs with spaces', () => {
    expect(() => validateRefIsSecure('main; rm -rf /')).toThrow('potentially insecure');
  });
  test('rejects refs with backticks', () => {
    expect(() => validateRefIsSecure('`whoami`')).toThrow('potentially insecure');
  });
  test('rejects refs with dollar signs', () => {
    expect(() => validateRefIsSecure('$(whoami)')).toThrow('potentially insecure');
  });
  test('accepts valid refs', () => {
    expect(validateRefIsSecure('main')).toBe('main');
    expect(validateRefIsSecure('2.4.6-p1')).toBe('2.4.6-p1');
    expect(validateRefIsSecure('feature/new-thing')).toBe('feature/new-thing');
  });
});
```

**Coverage Goal:** 60%

---

### 8. `src/packagist.js`

**Current Coverage:** 0%

| Function | Priority | Test Type | Notes |
|----------|----------|-----------|-------|
| `fetchUrl()` | Low | Integration | Mock https |
| `fetchPackagistList()` | Medium | Integration | Mock fetchUrl |
| `isOnPackagist()` | High | Unit | Cache-based check |

```javascript
describe('isOnPackagist', () => {
  beforeEach(() => {
    // Setup cache mock
  });

  test('returns false for magento vendor', () => {
    expect(isOnPackagist('magento', 'magento/module-catalog')).toBe(false);
  });

  test('throws if vendor not loaded', () => {
    expect(() => isOnPackagist('unknown', 'unknown/package'))
      .toThrow('Package list for vendor unknown not loaded');
  });

  test('returns true for packages in cache', () => {
    // Requires cache setup
  });
});
```

**Coverage Goal:** 70%

---

### 9. Type Classes (`src/type/*.js`)

**Current Coverage:** 0%

These are data classes that should have basic instantiation tests.

| Class | Test Cases Needed |
|-------|-------------------|
| `repositoryBuildDefinition` | Constructor, default values, init methods |
| `packageDefinition` | Constructor, default values |
| `buildState` | Constructor, default values |
| `metapackageDefinition` | Constructor, default values |
| `packageReplacement` | Constructor, default values |
| `extraRefToRelease` | Constructor, default values |

**Recommended Test File: `tests/types.test.js`**

```javascript
const repositoryBuildDefinition = require('../src/type/repository-build-definition');
const packageDefinition = require('../src/type/package-definition');
const buildState = require('../src/type/build-state');

describe('repositoryBuildDefinition', () => {
  test('initializes with default values', () => {
    const def = new repositoryBuildDefinition({});
    expect(def.vendor).toBe('magento');
    expect(def.packageDirs).toEqual([]);
    expect(def.transform).toEqual({});
  });

  test('accepts custom values', () => {
    const def = new repositoryBuildDefinition({
      repoUrl: 'https://github.com/test/repo.git',
      vendor: 'mage-os',
      ref: 'main'
    });
    expect(def.repoUrl).toBe('https://github.com/test/repo.git');
    expect(def.vendor).toBe('mage-os');
    expect(def.ref).toBe('main');
  });

  test('initializes nested packageDefinitions', () => {
    const def = new repositoryBuildDefinition({
      packageDirs: [{ label: 'Test', dir: 'src' }]
    });
    expect(def.packageDirs[0]).toBeInstanceOf(packageDefinition);
  });
});
```

**Coverage Goal:** 90%

---

### 10. Transform Functions

**Current Coverage:** 0%

#### `src/build-metapackage/magento-community-edition.js`

| Function | Priority | Test Cases |
|----------|----------|------------|
| `transformMagentoCommunityEditionProject()` | High | 5 cases |
| `transformMagentoCommunityEditionProduct()` | High | 5 cases |

#### `src/build-metapackage/mage-os-community-edition.js`

| Function | Priority | Test Cases |
|----------|----------|------------|
| `transformMageOSCommunityEditionProject()` | High | 4 cases |
| `transformMageOSCommunityEditionProduct()` | High | 4 cases |

**Coverage Goal:** 80%

---

### 11. `src/integrity-test/validate-package-versions-match.js`

**Current Coverage:** 0%

| Function | Priority | Test Type |
|----------|----------|-----------|
| `getComposerPackagesConfig()` | Medium | Integration |
| `comparePackages()` | High | Unit |
| `displayDiffs()` | Low | Unit |

**Coverage Goal:** 60%

---

### 12. Build Configuration Files

**Current Coverage:** Partial (one exclude function tested)

#### `src/build-config/packages-config.js`

| Item | Priority | Notes |
|------|----------|-------|
| Exclude functions | High | Complex conditional logic |
| Package structure integrity | Medium | Schema validation |

**Coverage Goal:** 70% for exclude functions

---

## Implementation Priority

### Phase 1: Critical Security & Core Logic (Week 1-2)
1. ✅ `validateRefIsSecure()` and `validateBranchIsSecure()` - Security critical
2. `getVersionStability()` - Core version logic
3. `chooseNameAndVersion()` - Core package naming
4. `setDependencyVersions()` - Dependency management
5. `validateVersionString()` - Input validation
6. Type classes - Foundation for other tests

### Phase 2: Business Logic (Week 3-4)
1. `setMageOsVendor()` and related transform functions
2. `updateComposerConfigFromMagentoToMageOs()`
3. Transform functions in `build-metapackage/`
4. `lastTwoDirs()` and other utility functions
5. `isOnPackagist()` and cache logic

### Phase 3: Integration Tests (Week 5-6)
1. `createPackageForRef()` with mocked dependencies
2. `readComposerJson()` with mocked repo
3. `listTagsFrom()` with mocked git
4. `replacePackageFiles()` with mocked fs
5. `DependencyAnalyzer` methods

### Phase 4: E2E & Edge Cases (Week 7-8)
1. `processMirrorInstruction()` workflow
2. `processNightlyBuildInstructions()` workflow
3. Build configuration validation
4. Error handling edge cases

---

## Test Infrastructure Requirements

### Jest Configuration Updates

```javascript
// jest.config.js additions
module.exports = {
  clearMocks: true,
  coverageProvider: "v8",
  collectCoverage: true,
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/make/**/*.js",  // CLI entry points
    "!src/build-config/**/*.js"  // Configuration files
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    },
    "./src/utils.js": {
      branches: 80,
      functions: 90,
      lines: 85
    },
    "./src/package-modules.js": {
      branches: 70,
      functions: 80,
      lines: 75
    },
    "./src/repository/shell-git.js": {
      branches: 60,
      functions: 60,
      lines: 60
    }
  },
  testMatch: [
    "**/tests/**/*.test.js"
  ],
  modulePathIgnorePatterns: [
    "<rootDir>/node_modules/"
  ]
};
```

### Mock Utilities Needed

Create `tests/__mocks__/` directory with:

1. **`fs.js`** - File system operations mock
2. **`child_process.js`** - Shell command mock
3. **`https.js`** - Network request mock
4. **`jszip.js`** - ZIP operations mock
5. **`repository.js`** - Git repository mock

### Test Fixtures

Create `tests/__fixtures__/` directory with:

1. Sample `composer.json` files
2. Sample package structures
3. Sample git tag lists
4. Sample build configurations

---

## Coverage Goals Summary

| Module | Current | Target | Priority |
|--------|---------|--------|----------|
| `utils.js` | ~60% | 90% | High |
| `package-modules.js` | 0% | 80% | Critical |
| `mirror-build-tools.js` | 0% | 60% | Medium |
| `release-build-tools.js` | 0% | 75% | High |
| `release-branch-build-tools.js` | ~40% | 85% | Medium |
| `determine-dependencies.js` | 0% | 50% | Low |
| `repository/shell-git.js` | ~5% | 60% | High |
| `packagist.js` | 0% | 70% | Medium |
| `type/*.js` | 0% | 90% | Medium |
| `build-metapackage/*.js` | 0% | 80% | High |
| `integrity-test/*.js` | 0% | 60% | Low |

**Overall Target: 65-70% code coverage**

---

## Metrics & Reporting

### CI Integration

Add to CI pipeline:
```yaml
- name: Run tests with coverage
  run: npm test -- --coverage --coverageReporters=lcov

- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
```

### Coverage Reports

Generate reports with:
```bash
npm test -- --coverage --coverageReporters=html,text-summary
```

---

## Maintenance Guidelines

1. **New Code:** All new functions require unit tests before merge
2. **Bug Fixes:** Each bug fix should include a regression test
3. **Refactoring:** Maintain or improve coverage during refactoring
4. **Dependencies:** Update mocks when dependencies change
5. **Review:** PRs should not decrease coverage below thresholds

---

## Appendix: Test File Structure

```
tests/
├── __fixtures__/
│   ├── composer-samples/
│   ├── package-structures/
│   └── build-configs/
├── __mocks__/
│   ├── fs.js
│   ├── child_process.js
│   ├── https.js
│   └── repository.js
├── build-config/
│   └── packages-config.test.js (existing)
├── repository/
│   └── shell-git.test.js (rename from pure-js-git.test.js)
├── types/
│   └── types.test.js (new)
├── build-metapackage/
│   ├── magento-community-edition.test.js (new)
│   └── mage-os-community-edition.test.js (new)
├── determine-dependencies.test.js (new)
├── mirror-build-tools.test.js (new)
├── package-modules.test.js (new)
├── packagist.test.js (new)
├── release-branch-build-tools.test.js (existing)
├── release-build-tools.test.js (new)
└── utils.test.js (existing, expand)
```

---

*Document Version: 1.0*
*Created: 2026-01-30*
*Last Updated: 2026-01-30*
