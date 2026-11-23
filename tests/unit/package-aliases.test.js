'use strict';

const {newestReplacers} = require('../../src/package-aliases');

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
