// Runtime import cycles between src features, even when no single file is on the cycle (a/1 -> b/1,
// b/2 -> a/2). File cycles are oxlint's import/no-cycle. Type-only imports drop out, since tsc erases them.
'use strict';

// base, domain and surface hold one folder per feature; any other top folder is one feature whole.
const FEATURE_LAYERS = 'base|domain|surface';
const comment = 'two features never import each other at runtime; move the shared piece into a folder both import';

/** A folder-level cycle rule: `from` names the feature a folder sits in, and a step inside it does not count. */
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
