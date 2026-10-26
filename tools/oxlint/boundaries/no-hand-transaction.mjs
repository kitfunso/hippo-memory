// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

import { textOf } from './nodes.mjs';

const BEGIN = /^\s*BEGIN/;

/** Bars SQL text that opens a transaction, so src/db/busy.ts stays the one place that takes the
 * write lock. */
export const noHandTransactionRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a hand-written BEGIN outside the transaction helpers.' },
    messages: { begin: 'This opens a transaction by hand; run the work through the helpers in src/db/busy.ts.' },
  },
  createOnce(context) {
    return {
      Literal: (node) => {
        if (BEGIN.test(textOf(node) ?? '')) context.report({ node, messageId: 'begin' });
      },
      TemplateLiteral: (node) => {
        if (BEGIN.test(node.quasis[0]?.value.raw ?? '')) context.report({ node, messageId: 'begin' });
      },
    };
  },
});
