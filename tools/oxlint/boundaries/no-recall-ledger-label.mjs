// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

import { textOf } from './nodes.mjs';

const RECALL_LABELS = new Set(['recall', 'http_recall', 'mcp_recall']);
const BOOKING = "CallExpression:matches([callee.name='recordTokens'], [callee.property.name='recordTokens'])";

/** Bars a surface from booking a recall's token row; src/api/recall/finish.ts books it for the
 * surface that passes `recordAs`. */
export const noRecallLedgerLabelRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow booking a recall token row outside the recall use case.' },
    messages: { label: 'This books a recall token row; pass `recordAs` to retrieve() and let it book the row.' },
  },
  createOnce(context) {
    /** @param {import('@oxlint/plugins').ESTree.Node} node */
    const check = (node) => {
      if (RECALL_LABELS.has(textOf(node) ?? '')) context.report({ node, messageId: 'label' });
    };
    return { [`${BOOKING} Literal`]: check, [`${BOOKING} TemplateLiteral`]: check };
  },
});
