const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, 'node_modules/@google/genai/dist/web/index.mjs')],
  bundle: true,
  format: 'esm',
  outfile: 'js-genai.js',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  sourcemap: false,
}).then(() => {
  console.log('Successfully bundled @google/genai');
}).catch((error) => {
  console.error('Error bundling @google/genai:', error);
  process.exit(1);
});

