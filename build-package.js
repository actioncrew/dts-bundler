const fs = require('fs');
const path = require('path');

const mainPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const distPackage = {
  name: mainPackage.name,
  version: mainPackage.version,
  description: mainPackage.description,
  bin: {
    "dts-bundler": "bin/dts-bundler"
  },
  files: [
    'README.md',
    'LICENSE',
    'package.json',
    'bin/',
    'node_modules/'
  ],
  keywords: mainPackage.keywords || [],
  author: mainPackage.author,
  license: mainPackage.license,
  bundleDependencies: mainPackage.bundleDependencies || {},
  dependencies: mainPackage.dependencies || {},
  peerDependencies: mainPackage.peerDependencies || {}
};

fs.writeFileSync(
  path.join('dist/dts-bundler/', 'package.json'),
  JSON.stringify(distPackage, null, 2)
);
