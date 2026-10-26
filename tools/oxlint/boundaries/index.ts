import { eslintCompatPlugin } from '@oxlint/plugins';

import { maxSignatureParamsRule } from './max-signature-params.ts';
import { noAdapterNameRule } from './no-adapter-name.ts';

/** Rules the import graph and the built-in rules cannot see; .dependency-cruiser.cjs holds the
 * import rules. */
const boundariesPlugin = eslintCompatPlugin({
  meta: { name: 'boundaries' },
  rules: { 'max-signature-params': maxSignatureParamsRule, 'no-adapter-name': noAdapterNameRule },
});

export default boundariesPlugin;
