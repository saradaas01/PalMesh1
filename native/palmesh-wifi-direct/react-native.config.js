'use strict';

module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.palmesh.wifidirect.PalMeshWifiDirectPackage;',
        packageInstance: 'new PalMeshWifiDirectPackage()',
      },
      ios: { podspecPath: './PalMeshWifiDirect.podspec' },
    },
  },
};
