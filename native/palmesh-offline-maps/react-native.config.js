'use strict';

module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.palmesh.offlinemaps.PalMeshOfflineMapsPackage;',
        packageInstance: 'new PalMeshOfflineMapsPackage()',
      },
      ios: { podspecPath: './PalMeshOfflineMaps.podspec' },
    },
  },
};
