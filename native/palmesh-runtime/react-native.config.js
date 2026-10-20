'use strict';

module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.palmesh.runtime.PalMeshRuntimePackage;',
        packageInstance: 'new PalMeshRuntimePackage()',
      },
      ios: { podspecPath: './PalMeshRuntime.podspec' },
    },
  },
};
