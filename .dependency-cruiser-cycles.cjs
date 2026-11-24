'use strict';

const FEATURE_LAYERS = 'base|domain|surface';
const comment = 'two features never import each other at runtime; move the shared piece into a folder both import';

const cycleRule = (name, from, inside) => ({
  name,
  comment,
  severity: 'error',
  scope: 'folder',
  from: { path: from },
  to: { circular: true, pathNot: inside },
});

module.exports = {
  forbidden: [
    cycleRule('no-feature-cycles', `^src/(${FEATURE_LAYERS})/([^/]+)`, '^src/$1/$2(/|$)'),
    cycleRule('no-layer-root-cycles', `^src/(${FEATURE_LAYERS})$`, '^src/$1$'),
    cycleRule('no-layer-cycles', `^src/(?!(?:${FEATURE_LAYERS})(?:/|$))([^/]+)`, '^src/$1(/|$)'),
  ],
  options: {
    includeOnly: '^src/',
    exclude: { path: '[.]d[.]ts$', dynamic: true },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
