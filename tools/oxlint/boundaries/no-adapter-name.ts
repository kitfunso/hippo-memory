import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

const ADAPTER_NAME = /sqlite/i;

function isText(node: ESTree.Literal): node is ESTree.StringLiteral {
  return typeof node.value === 'string';
}

/** A module path belongs to the import rules in .dependency-cruiser.cjs, which judge where it points. */
function isModulePath(node: ESTree.StringLiteral): boolean {
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
    const reportName = (node: ESTree.Node, text: string): void => {
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
