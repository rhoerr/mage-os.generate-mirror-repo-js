const configs = {
  mirror: require('../../../src/build-config/mirror-build-config').buildConfig,
  'mageos-release': require('../../../src/build-config/mageos-release-build-config').buildConfig,
  'mageos-nightly': require('../../../src/build-config/mageos-nightly-build-config').buildConfig,
  'upstream-nightly': require('../../../src/build-config/upstream-nightly-build-config').buildConfig,
};

describe('requireHistory wiring', () => {
  test('the mirror builds magento/product-community-edition only from release history', () => {
    const magento2Instruction = configs.mirror.find(instruction => instruction.key === 'magento2');
    expect(magento2Instruction.requireHistory).toEqual(['product-community-edition']);
  });

  test.each(['mageos-release', 'mageos-nightly', 'upstream-nightly'])('%s builds resolve new versions from the template', name => {
    expect(configs[name].filter(instruction => instruction.requireHistory.length)).toEqual([]);
  });
});
