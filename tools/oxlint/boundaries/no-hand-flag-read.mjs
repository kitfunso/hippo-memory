// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

import { isNamed } from './nodes.mjs';

/** @typedef {import('@oxlint/plugins').ESTree.Node} Node */

/**
 * `flags.x` or `flags[k]`: one parsed flag.
 * @param {Node} node
 * @returns {boolean}
 */
const isFlag = (node) => node.type === 'MemberExpression' && isNamed(node.object, 'flags');

/**
 * The node an expression starts from, as in `flags.x ?? ''` or `flags.x.trim()`.
 * @param {Node} node
 * @returns {Node}
 */
function leftmost(node) {
  switch (node.type) {
    case 'BinaryExpression':
    case 'LogicalExpression':
      return leftmost(node.left);
    case 'ConditionalExpression':
      return leftmost(node.test);
    case 'MemberExpression':
      return isFlag(node) ? node : leftmost(node.object);
    case 'CallExpression':
      return leftmost(node.callee);
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return leftmost(node.expression);
    default:
      return node;
  }
}

/** Bars turning a flag into text by hand: parseArgs hands a value-less flag over as `true`, which
 * String() stores as the word "true". */
export const noHandFlagReadRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow reading a CLI flag as text without the flag-values helpers.' },
    messages: {
      hand: 'Read the flag through stringFlagOrExit, nonEmptyStringFlag, stringListFlag or numberFlag in src/surface/cli/flag-values.ts.',
    },
  },
  createOnce(context) {
    /** @param {Node} node */
    const report = (node) => context.report({ node, messageId: 'hand' });
    return {
      "CallExpression[callee.name='String']": (node) => {
        const [first] = node.arguments;
        if (first !== undefined && isFlag(leftmost(first))) report(node);
      },
      TemplateLiteral: (node) => {
        for (const part of node.expressions) if (isFlag(part)) report(part);
      },
      "TSAsExpression[typeAnnotation.type='TSStringKeyword']": (node) => {
        if (isFlag(node.expression)) report(node);
      },
    };
  },
});
