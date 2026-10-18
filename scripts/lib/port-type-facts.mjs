// Parsing helpers and the port-parameter scan for check-store-port.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

export const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
export const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** The src file a relative specifier names, with .js read as .ts; undefined when it is not a file on disk. */
export function resolveSpec(file, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = posix.join(posix.dirname(file), spec).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}/index.ts`].find((c) => existsSync(c));
}

// port-groups.ts holds the session and admin groups (conflicts, dormant), so it is a port file here too.
const declaresPort = (f) => f === 'src/store/port.ts' || f.startsWith('src/store/port/') || f === 'src/store/port-groups.ts';
const typeTables = new Map();

/** The interfaces and type aliases a file declares, and the file and name each imported or re-exported name comes from. */
function typeTable(file) {
  if (typeTables.has(file)) return typeTables.get(file);
  const sf = parse(file);
  const decls = new Map();
  const links = new Map();
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) decls.set(s.name.text, [...(decls.get(s.name.text) ?? []), s]);
    const target = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? resolveSpec(file, s.moduleSpecifier.text) : undefined;
    const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : ts.isExportDeclaration(s) ? s.exportClause : undefined;
    if (target && named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
      for (const e of named.elements) links.set(e.name.text, { file: target, name: (e.propertyName ?? e.name).text });
    }
  }
  const table = { sf, decls, links };
  typeTables.set(file, table);
  return table;
}

/** The declarations `name` resolves to from `file`, following imports and re-exports into src; [] for a lib or generic name. */
function declarationsOf(file, name, hops = 0) {
  const { decls, links } = typeTable(file);
  if (decls.has(name)) return decls.get(name).map((node) => ({ file, node }));
  const link = links.get(name);
  return link && hops < 10 ? declarationsOf(link.file, link.name, hops + 1) : [];
}

/** The first function a member list holds, as `.member` plus its path, or null. */
function functionInMembers(file, members, seen) {
  for (const m of members) {
    if (ts.isMethodSignature(m)) return `.${m.name.getText()}`;
    if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) return '';
    const inner = ts.isPropertySignature(m) ? functionIn(file, m.type, seen) : null;
    if (inner !== null) return `.${m.name.getText()}${inner}`;
  }
  return null;
}

/** The path to the first function a type holds ('' when it is one), or null when it is data. Lib and generic names are
 * data; src interfaces and aliases are read through their members, unions, intersections, arrays and type arguments. */
function functionIn(file, node, seen) {
  if (!node) return null;
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return '';
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return functionIn(file, node.type, seen);
  if (ts.isArrayTypeNode(node)) return functionIn(file, node.elementType, seen);
  if (ts.isTypeLiteralNode(node)) return functionInMembers(file, node.members, seen);
  const parts = ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node) ? node.types
    : ts.isTupleTypeNode(node) ? node.elements : ts.isTypeReferenceNode(node) ? node.typeArguments ?? [] : [];
  for (const part of parts) {
    const inner = functionIn(file, part, seen);
    if (inner !== null) return inner;
  }
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  for (const decl of declarationsOf(file, node.typeName.text)) {
    const key = `${decl.file}#${node.typeName.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inner = ts.isTypeAliasDeclaration(decl.node) ? functionIn(decl.file, decl.node.type, seen) : functionInDeclared(decl.file, decl.node, seen);
    if (inner !== null) return inner;
  }
  return null;
}

/** An interface's own members, then each interface it extends. */
function functionInDeclared(file, iface, seen) {
  const own = functionInMembers(file, iface.members, seen);
  if (own !== null) return own;
  for (const clause of iface.heritageClauses ?? []) {
    for (const base of clause.types) {
      const inner = ts.isIdentifier(base.expression) ? functionIn(file, ts.factory.createTypeReferenceNode(base.expression.text, base.typeArguments), seen) : null;
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** `file:line Owner.method(param.path)` for each parameter of a method on a port interface or object alias whose type holds a function. */
export function portFunctionParams(file) {
  if (!declaresPort(file)) return [];
  const { sf, decls } = typeTable(file);
  const hits = [];
  for (const [owner, nodes] of decls) {
    for (const node of nodes) {
      const members = ts.isInterfaceDeclaration(node) ? node.members : ts.isTypeLiteralNode(node.type) ? node.type.members : [];
      for (const m of members) {
        const fn = ts.isMethodSignature(m) ? m : ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type) ? m.type : undefined;
        for (const p of fn?.parameters ?? []) {
          const path = functionIn(file, p.type, new Set());
          if (path !== null) hits.push(`${file}:${lineOf(sf, p)} ${owner}.${m.name.getText(sf)}(${p.name.getText(sf)}${path})`);
        }
      }
    }
  }
  return hits;
}
