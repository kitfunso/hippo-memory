import { eslintCompatPlugin } from '@oxlint/plugins';

import { maxSignatureParamsRule } from './max-signature-params.mjs';
import { noAdapterNameRule } from './no-adapter-name.mjs';
import { noEnvWriteRule } from './no-env-write.mjs';
import { noHandFailRule } from './no-hand-fail.mjs';
import { noHandFlagReadRule } from './no-hand-flag-read.mjs';
import { noHandTransactionRule } from './no-hand-transaction.mjs';
import { noRecallLedgerLabelRule } from './no-recall-ledger-label.mjs';
import { noStoreBranchRule } from './no-store-branch.mjs';
import { noTwinFunctionRule } from './no-twin-function.mjs';

const boundariesPlugin = eslintCompatPlugin({
  meta: { name: 'boundaries' },
  rules: {
    'max-signature-params': maxSignatureParamsRule,
    'no-adapter-name': noAdapterNameRule,
    'no-env-write': noEnvWriteRule,
    'no-hand-fail': noHandFailRule,
    'no-hand-flag-read': noHandFlagReadRule,
    'no-hand-transaction': noHandTransactionRule,
    'no-recall-ledger-label': noRecallLedgerLabelRule,
    'no-store-branch': noStoreBranchRule,
    'no-twin-function': noTwinFunctionRule,
  },
});

export default boundariesPlugin;
