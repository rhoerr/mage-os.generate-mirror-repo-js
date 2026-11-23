'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sut = require('../../src/ref-ledger');
const repositoryBuildDefinition = require('../../src/type/repository-build-definition');

const sha = char => char.repeat(40);
const FINGERPRINT = 'f'.repeat(64);

function instruction(overrides = {}) {
  return new repositoryBuildDefinition({
    key: 'magento2',
    repoUrl: 'https://github.com/mage-os/mirror-magento2.git',
    ref: 'main',
    fromTag: '2.4.0',
    packageDirs: [{label: 'Modules', dir: 'app/code/Magento', excludes: ['app/code/Magento/Skip/']}],
    packageIndividual: [{label: 'Base', dir: '', excludes: [(ref, file) => file === '.github']}],
    extraRefToRelease: [{ref: sha('e'), release: '2.4.0-p9', details: 'missing upstream tag'}],
    transform: {'magento/product-community-edition': [composer => composer]},
    ...overrides,
  });
}

function ref(overrides = {}) {
  return {instruction: 'magento2', tag: '2.4.7', commit: sha('a'), fingerprint: FINGERPRINT, ...overrides};
}

describe('ref-ledger', () => {
  describe('file format', () => {
    it('round-trips rows sorted by instruction and tag', () => {
      const rows = [ref({tag: '2.4.8'}), ref({instruction: 'inventory'}), ref()];
      const text = sut.formatRefs(rows);
      expect(text.split('\n')[0]).toBe(sut.FIELDS.join('\t'));
      expect(sut.parseRefs(text).map(row => `${row.instruction} ${row.tag}`)).toEqual([
        'inventory 2.4.7', 'magento2 2.4.7', 'magento2 2.4.8',
      ]);
    });

    it.each([
      ['commit', {commit: 'abc'}],
      ['fingerprint', {fingerprint: ''}],
      ['tag', {tag: ''}],
      ['tab in a value', {tag: '2.4\t7'}],
    ])('rejects an invalid %s', (_, overrides) => {
      expect(() => sut.formatRefs([ref(overrides)])).toThrow();
    });

    it('rejects duplicate tags of an instruction and a wrong header', () => {
      expect(() => sut.formatRefs([ref(), ref({commit: sha('b')})])).toThrow(/duplicate/);
      expect(() => sut.parseRefs(sut.formatRefs([ref()]).replace('instruction', 'key'))).toThrow(/header/);
    });
  });

  describe('instructionFingerprint', () => {
    const URL = 'https://mirror.mage-os.org/';

    it('ignores what a build changes on the instruction', () => {
      const subject = instruction();
      const before = sut.instructionFingerprint(subject, URL);

      subject.ref = '2.0.0';
      subject.packageDirs[0].excludes.push('composer.json', '.git/');
      subject.packageIndividual[0].composerJsonFile = '/tmp/history/2.4.7.json';

      expect(sut.instructionFingerprint(subject, URL)).toBe(before);
      expect(sut.instructionFingerprint(instruction(), URL)).toBe(before);
    });

    it.each([
      ['the first tag', {fromTag: '2.4.1'}],
      ['the excludes', {packageDirs: [{label: 'Modules', dir: 'app/code/Magento', excludes: []}]}],
      ['a transform', {transform: {'magento/product-community-edition': [composer => ({...composer})]}}],
      ['an extra ref', {extraRefToRelease: [{ref: sha('d'), release: '2.4.0-p9'}]}],
      ['the fixed versions', {fixVersions: {'2.4.7': {'magento/module-a': '1.0.0'}}}],
    ])('changes with %s', (_, overrides) => {
      expect(sut.instructionFingerprint(instruction(overrides), URL)).not.toBe(sut.instructionFingerprint(instruction(), URL));
    });

    it('is the same in every checkout of this repository', () => {
      const otherCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-ledger-checkout-'));
      fs.mkdirSync(path.join(otherCheckout, 'src'));
      fs.copyFileSync(path.join(__dirname, '../../src/ref-ledger.js'), path.join(otherCheckout, 'src/ref-ledger.js'));
      const other = require(path.join(otherCheckout, 'src/ref-ledger.js'));
      const withTemplate = root => instruction({packageIndividual: [{
        label: 'Base',
        dir: '',
        composerJsonPath: `${root}/src/build-config/../../resource/composer-templates/magento/magento2-base/template.json`,
      }]});

      try {
        expect(other.instructionFingerprint(withTemplate(otherCheckout), URL))
          .toBe(sut.instructionFingerprint(withTemplate(path.join(__dirname, '../..')), URL));
      } finally {
        fs.rmSync(otherCheckout, {recursive: true, force: true});
      }
    });

    it('changes with the composer repository url', () => {
      expect(sut.instructionFingerprint(instruction(), 'https://preview-mirror.mage-os.org/'))
        .not.toBe(sut.instructionFingerprint(instruction(), URL));
    });
  });

  describe('isRepeatableFailure', () => {
    it.each([
      [{message: 'Unable to find composer.json'}, true],
      [{kind: 'VERSION_UNKNOWN', message: 'Unable find package version'}, true],
      [Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'}), true],
      ['Error executing command: git fetch failed', false],
      [new Error('socket hang up'), false],
      [null, false],
    ])('%p is repeatable: %p', (exception, expected) => {
      expect(sut.isRepeatableFailure(exception)).toBe(expected);
    });
  });

  describe('mergeRefs', () => {
    const ledgerRows = [{name: 'magento/module-a', version: '100.4.7'}, {name: 'magento/module-b', version: '100.4.7'}];
    const pending = (overrides = {}) => ({
      ...ref(),
      versions: [['magento/module-a', '100.4.7'], ['magento/module-b', '100.4.7']],
      ...overrides,
    });

    it('records a tag once every version it built is in the ledger', () => {
      const {rows, recorded, notPublished} = sut.mergeRefs([], [pending()], ledgerRows);
      expect(rows).toEqual([ref()]);
      expect(recorded).toBe(1);
      expect(notPublished).toEqual([]);
    });

    it('leaves out a tag that built a version the ledger does not have', () => {
      const {rows, notPublished} = sut.mergeRefs([], [pending({versions: [['magento/module-c', '100.4.7']]})], ledgerRows);
      expect(rows).toEqual([]);
      expect(notPublished).toEqual(['magento2 2.4.7']);
    });

    it('records a tag that built nothing', () => {
      expect(sut.mergeRefs([], [pending({versions: []})], ledgerRows).rows).toEqual([ref()]);
    });

    it('replaces the fingerprint of a rebuilt tag and keeps the other recorded tags', () => {
      const other = ref({tag: '2.4.6'});
      const {rows} = sut.mergeRefs([ref(), other], [pending({fingerprint: 'e'.repeat(64)})], ledgerRows);
      expect(rows).toEqual([ref({fingerprint: 'e'.repeat(64)}), other]);
    });

    it('fails on a recorded tag that now points at another commit', () => {
      expect(() => sut.mergeRefs([ref()], [pending({commit: sha('b')})], ledgerRows)).toThrow(/was recorded at a+ and now points at b+/);
    });
  });

  describe('createRefRecorder', () => {
    const URL = 'https://mirror.mage-os.org/';
    let dir;
    let remote;
    const listRemoteTags = jest.fn(async () => remote);
    const recorded = (tag, overrides = {}) => ref({tag, fingerprint: sut.instructionFingerprint(instruction(), URL), ...overrides});

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-ledger-'));
      remote = new Map([['2.4.6', sha('6')], ['2.4.7', sha('7')], ['2.4.8', sha('8')]]);
      listRemoteTags.mockClear();
    });

    afterEach(() => {
      fs.rmSync(dir, {recursive: true, force: true});
    });

    it('skips recorded tags and extra refs at their recorded commit', async () => {
      const rows = [recorded('2.4.6', {commit: sha('6')}), recorded('2.4.0-p9', {commit: sha('e')})];
      const refs = await sut.createRefRecorder({rows, skip: true, listRemoteTags}).forInstruction(instruction(), URL);

      expect(listRemoteTags).toHaveBeenCalledWith('https://github.com/mage-os/mirror-magento2.git');
      expect(['2.4.6', '2.4.7', '2.4.0-p9'].map(refs.isRecorded)).toEqual([true, false, true]);
      expect(refs.remoteTags()).toEqual(['2.4.6', '2.4.7', '2.4.8']);
    });

    it('skips nothing on a full rebuild, but still checks the recorded commits', async () => {
      const recorder = sut.createRefRecorder({rows: [recorded('2.4.6', {commit: sha('6')})], skip: false, listRemoteTags});
      expect((await recorder.forInstruction(instruction(), URL)).isRecorded('2.4.6')).toBe(false);

      remote.set('2.4.6', sha('0'));
      await expect(recorder.forInstruction(instruction(), URL)).rejects.toThrow(/moved/);
    });

    it('does not trust tags recorded with another configuration', async () => {
      const rows = [recorded('2.4.6', {commit: sha('6'), fingerprint: 'e'.repeat(64)})];
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const refs = await sut.createRefRecorder({rows, skip: true, listRemoteTags}).forInstruction(instruction(), URL);
      console.log.mockRestore();
      expect(refs.isRecorded('2.4.6')).toBe(false);
    });

    it.each([
      ['moved', recorded('2.4.6', {commit: sha('0')}), /moved from 0+ to 6+/],
      ['deleted', recorded('2.3.0', {commit: sha('0')}), /no longer exists/],
      ['an extra ref pointed elsewhere', recorded('2.4.0-p9', {commit: sha('0')}), /moved from 0+ to e+/],
    ])('fails on a recorded tag that was %s', async (_, row, message) => {
      await expect(sut.createRefRecorder({rows: [row], skip: true, listRemoteTags}).forInstruction(instruction(), URL))
        .rejects.toThrow(message);
    });

    it('writes the tags processed without a failure that a later run could avoid', async () => {
      const pendingFile = path.join(dir, 'out', 'refs-pending.json');
      const refs = await sut.createRefRecorder({listRemoteTags, pendingFile}).forInstruction(instruction(), URL);

      refs.built('2.4.6', {'magento/module-a': '100.4.6'});
      refs.built('2.4.6', {'magento/module-b': '100.4.6', 'magento/module-a': '100.4.6'});
      refs.failed('2.4.6', {message: 'Unable to find composer.json'});
      refs.built('2.4.7', {'magento/module-a': '100.4.7'});
      refs.failed('2.4.7', 'Error executing command: git fetch');
      refs.built('2.4.0-p9', {'magento/module-a': '100.4.0-p9'});
      refs.built('local-only', {'magento/module-a': '0.0.1'});
      refs.done();

      const fingerprint = sut.instructionFingerprint(instruction(), URL);
      expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toEqual([
        {instruction: 'magento2', tag: '2.4.6', commit: sha('6'), fingerprint, versions: [['magento/module-a', '100.4.6'], ['magento/module-b', '100.4.6']]},
        {instruction: 'magento2', tag: '2.4.0-p9', commit: sha('e'), fingerprint, versions: [['magento/module-a', '100.4.0-p9']]},
      ]);
    });
  });
});
