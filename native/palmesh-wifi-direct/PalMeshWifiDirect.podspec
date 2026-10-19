require "json"
package = JSON.parse(File.read(File.join(__dir__, "package.json")))
Pod::Spec.new do |s|
  s.name = "PalMeshWifiDirect"
  s.version = package["version"]
  s.summary = package["description"]
  s.homepage = "https://github.com/saradaas01/PalMesh1"
  s.license = { :type => "UNLICENSED" }
  s.author = { "PalMesh" => "https://github.com/saradaas01/PalMesh1" }
  s.source = { :git => "https://github.com/saradaas01/PalMesh1.git", :tag => s.version.to_s }
  s.platforms = { :ios => "15.1" }
  s.source_files = "ios/**/*.{h,m,mm}"
  s.frameworks = 'CoreBluetooth', 'UIKit'
  install_modules_dependencies(s)
end
