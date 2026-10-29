// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

// The same limit as max-params in oxlint.config.ts, which skips the four signature kinds below.
const MAX_POSITIONAL = 5;

/**
 * @typedef {import('@oxlint/plugins').ESTree.TSMethodSignature
 *   | import('@oxlint/plugins').ESTree.TSCallSignatureDeclaration
 *   | import('@oxlint/plugins').ESTree.TSConstructSignatureDeclaration
 *   | import('@oxlint/plugins').ESTree.TSConstructorType} Signature
 */

/**
 * Parameters a caller passes by position: a rest parameter and a `this` type take none.
 * @param {Signature} node
 * @returns {number}
 */
function positionalCount(node) {
  return node.params.filter(
    (param) => param.type !== 'RestElement' && !(param.type === 'Identifier' && param.name === 'this'),
  ).length;
}

/** Holds interface methods, call and construct signatures and constructor types to the max-params
 * limit, so a port method cannot ask its implementations for a longer list. */
export const maxSignatureParamsRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Limit positional parameters on signatures and constructor types.' },
    messages: {
      tooMany: 'This signature takes {{count}} positional parameters; take one options object past {{max}}.',
    },
  },
  createOnce(context) {
    /** @param {Signature} node */
    const check = (node) => {
      const count = positionalCount(node);
      if (count > MAX_POSITIONAL) {
        context.report({ node, messageId: 'tooMany', data: { count: String(count), max: String(MAX_POSITIONAL) } });
      }
    };
    return {
      TSMethodSignature: check,
      TSCallSignatureDeclaration: check,
      TSConstructSignatureDeclaration: check,
      TSConstructorType: check,
    };
  },
});
