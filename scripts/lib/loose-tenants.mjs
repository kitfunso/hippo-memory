// The tenant scan for check-store-port.mjs: a src/store function or port method whose tenant can be left out reads
// every tenant by accident, so each one names a tenant or ALL_TENANTS.
import ts from 'typescript';
import { declarationsOf, lineOf, parse } from './port-type-facts.mjs';

const TENANT_NAMES = new Set(['tenant', 'tenantId']);

/** True when a type node lets the value be undefined or null. */
function admitsNothing(node) {
  if (!node) return false;
  if (ts.isParenthesizedTypeNode(node)) return admitsNothing(node.type);
  if (ts.isUnionTypeNode(node)) return node.types.some(admitsNothing);
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

const namesTenant = (name) => name !== undefined && ts.isIdentifier(name) && TENANT_NAMES.has(name.text);

/** The tenant members a type node holds that may be left out, as `Owner.member`, read through src aliases, interfaces,
 * intersections, unions and type arguments. */
function looseMembers(file, node, seen) {
  if (!node) return [];
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return looseMembers(file, node.type, seen);
  if (ts.isTypeLiteralNode(node)) return looseIn(node.members, '{}');
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap((t) => looseMembers(file, t, seen));
  }
  if (!ts.isTypeReferenceNode(node)) return [];
  const viaArgs = (node.typeArguments ?? []).flatMap((t) => looseMembers(file, t, seen));
  if (!ts.isIdentifier(node.typeName)) return viaArgs;
  const name = node.typeName.text;
  const viaDecls = declarationsOf(file, name).flatMap((decl) => {
    const key = `${decl.file}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (ts.isTypeAliasDeclaration(decl.node)) return looseMembers(decl.file, decl.node.type, seen);
    const bases = (decl.node.heritageClauses ?? []).flatMap((c) => c.types);
    return [
      ...looseIn(decl.node.members, name),
      ...bases.flatMap((b) =>
        ts.isIdentifier(b.expression)
          ? looseMembers(decl.file, ts.factory.createTypeReferenceNode(b.expression.text, b.typeArguments), seen)
          : [],
      ),
    ];
  });
  return [...viaArgs, ...viaDecls];
}

function looseIn(members, owner) {
  return members
    .filter((m) => ts.isPropertySignature(m) && namesTenant(m.name) && (m.questionToken || admitsNothing(m.type)))
    .map((m) => `${owner}.${m.name.text}`);
}

/** Why a parameter's tenant may be left out, or [] when it may not. */
function looseParam(file, p, seen) {
  if (namesTenant(p.name) && (p.questionToken || p.initializer || admitsNothing(p.type))) return [p.name.text];
  const defaulted = ts.isObjectBindingPattern(p.name)
    ? p.name.elements.filter((e) => e.initializer && namesTenant(e.propertyName ?? e.name)).map((e) => e.name.getText())
    : [];
  return [...defaulted, ...looseMembers(file, p.type, seen)];
}

/** `file:line name(param: why)` for each parameter of a function or method in `file` whose tenant may be left out. */
export function looseTenants(file) {
  if (!file.startsWith('src/store/')) return [];
  const sf = parse(file);
  const hits = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) {
      const owner = node.name ? node.name.getText(sf) : '(anonymous)';
      for (const p of node.parameters) {
        for (const why of looseParam(file, p, new Set())) {
          hits.push(`${file}:${lineOf(sf, p)} ${owner}(${p.name.getText(sf).slice(0, 40)}: ${why})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
