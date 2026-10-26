// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { defineRule } from '@oxlint/plugins';

/** @typedef {import('@oxlint/plugins').ESTree.StringLiteral} StringLiteral */

const ADAPTER_NAME = /sqlite/i;

/**
 * A string literal keeps its quote in `raw`; a number, boolean, null or regex does not.
 * @param {import('@oxlint/plugins').ESTree.Literal} node
 * @returns {node is StringLiteral}
 */
function isText(node) {
  return node.raw !== null && /^['"]/.test(node.raw);
}

/**
 * A module path belongs to the import rules in .dependency-cruiser.cjs, which judge where it points.
 * @param {StringLiteral} node
 * @returns {boolean}
 */
function isModulePath(node) {
  const { parent } = node;
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
    case 'ImportExpression':
    case 'TSImportType':
      return parent.source === node;
    case 'TSExternalModuleReference':
      return parent.expression === node;
    default:
      return false;
  }
}

/** Bans the storage adapter's name in identifiers and string text, so a layer above the port stays
 * adapter-neutral. */
export const noAdapterNameRule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow naming the SQLite adapter in a layer that reads storage through the port.' },
    messages: {
      adapterName:
        '"{{text}}" names the SQLite adapter; this layer reaches storage through the port in src/base/ports.',
    },
  },
  createOnce(context) {
    /**
     * @param {import('@oxlint/plugins').ESTree.Node} node
     * @param {string} text
     */
    const reportName = (node, text) => {
      if (ADAPTER_NAME.test(text)) context.report({ node, messageId: 'adapterName', data: { text } });
    };
    return {
      Identifier: (node) => reportName(node, node.name),
      PrivateIdentifier: (node) => reportName(node, node.name),
      Literal: (node) => {
        if (isText(node) && !isModulePath(node)) reportName(node, node.value);
      },
      TemplateElement: (node) => reportName(node, node.value.raw),
    };
  },
});
