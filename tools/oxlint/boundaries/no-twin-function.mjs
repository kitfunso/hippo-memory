// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

const TWIN = /(?:ThroughStore|OnHippoDb|UnderStore|OnStore)$/;

/** Bars a second form of a function named for the store it runs on; one function takes the store. */
export const noTwinFunctionRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow twin functions named for the store they run on.' },
    messages: { twin: '"{{name}}" is a twin named for its store; keep one function that takes the store.' },
  },
  createOnce(context) {
    /** @param {import('@oxlint/plugins').ESTree.Function} node */
    const check = (node) => {
      if (node.id && TWIN.test(node.id.name)) {
        context.report({ node, messageId: 'twin', data: { name: node.id.name } });
      }
    };
    return { FunctionDeclaration: check, TSDeclareFunction: check };
  },
});
