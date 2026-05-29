// Bundle entry for highlight.js: core + the JSON grammar only, to keep the
// output small. `npm install` bundles this to hljs.js (gitignored) via esbuild.
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('json', json);

export default hljs;
