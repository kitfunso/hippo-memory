import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

// The same limit as max-params in .oxlintrc.json, which skips the four signature kinds below.
const MAX_POSITIONAL = 5;

type Signature =
  | ESTree.TSMethodSignature
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType;

/** Parameters a caller passes by position: a rest parameter and a `this` type take none. */
function positionalCount(node: Signature): number {
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
    const check = (node: Signature): void => {
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
