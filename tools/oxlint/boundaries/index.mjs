// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { eslintCompatPlugin } from '@oxlint/plugins';

import { maxSignatureParamsRule } from './max-signature-params.mjs';
import { noAdapterNameRule } from './no-adapter-name.mjs';

/** Rules the import graph and the built-in rules cannot see; .dependency-cruiser.cjs holds the
 * import rules. */
const boundariesPlugin = eslintCompatPlugin({
  meta: { name: 'boundaries' },
  rules: { 'max-signature-params': maxSignatureParamsRule, 'no-adapter-name': noAdapterNameRule },
});

export default boundariesPlugin;
