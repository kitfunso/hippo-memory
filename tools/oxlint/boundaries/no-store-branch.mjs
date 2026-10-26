// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

import { isDotted, isNamed, textOf } from './nodes.mjs';

/** @typedef {import('@oxlint/plugins').ESTree.Node} Node */

/**
 * `store` or `<x>.store`: how an api function holds the port.
 * @param {Node} node
 * @returns {boolean}
 */
const isStore = (node) => isNamed(node, 'store') || isDotted(node, 'store');

/**
 * `<store>.kind`, which names the backend.
 * @param {Node} node
 * @returns {boolean}
 */
const isStoreKind = (node) => node.type === 'MemberExpression' && isDotted(node, 'kind') && isStore(node.object);

/** Bars a ternary on the store and a comparison of its kind with a name, so each store answers
 * through its own methods. */
export const noStoreBranchRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow branching on which store backs the port.' },
    messages: { branch: 'This branches on the store; add a port method so each store answers for itself.' },
  },
  createOnce(context) {
    /**
     * @param {Node} side
     * @param {Node} other
     */
    const namesKind = (side, other) => isStoreKind(side) && textOf(other) !== undefined;
    return {
      ConditionalExpression: (node) => {
        if (isStore(node.test)) context.report({ node, messageId: 'branch' });
      },
      'BinaryExpression[operator=/^[!=]==?$/]': (node) => {
        if (namesKind(node.left, node.right) || namesKind(node.right, node.left)) {
          context.report({ node, messageId: 'branch' });
        }
      },
    };
  },
});
