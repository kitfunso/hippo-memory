// The worker-crossing scan of hippo.db's local tier for check-store-port.mjs. The tier has no port interface to read,
// so the TypeScript checker reads each repository's method types as hippoDbRepos infers them from its bodies.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const TIER_DOOR = 'src/store/sqlite/hippo-db.ts';
const REPOS = 'hippoDbRepos';
const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

const posix = (p) => p.split(sep).join('/').toLowerCase();

/** The type arguments `type` was made from: an alias's, then a generic reference's. */
const typeArguments = (checker, type) => [
  ...(type.aliasTypeArguments ?? []),
  ...((type.flags & ts.TypeFlags.Object) !== 0 && (type.objectFlags & ts.ObjectFlags.Reference) !== 0
    ? checker.getTypeArguments(type)
    : []),
];

/** The path to the first function any of `types` holds, or null. */
function firstIn(checker, inSrc, types, seen) {
  for (const part of types) {
    const inner = functionIn(checker, inSrc, part, seen);
    if (inner !== null) return inner;
  }
  return null;
}

/** The path to the first function `type` holds ('' when it is one), or null when it is data. Unions, intersections,
 * arrays and a non-src type's type arguments are read through; only a src type is read through its properties. */
function functionIn(checker, inSrc, type, seen) {
  if (seen.has(type)) return null;
  seen.add(type);
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return '';
  if (type.isUnionOrIntersection()) return firstIn(checker, inSrc, type.types, seen);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return firstIn(checker, inSrc, checker.getTypeArguments(type), seen);
  }
  const decls = (type.aliasSymbol ?? type.getSymbol())?.declarations ?? [];
  if ((type.flags & ts.TypeFlags.Object) === 0 || !decls.some(inSrc)) {
    return firstIn(checker, inSrc, typeArguments(checker, type), seen);
  }
  for (const prop of checker.getPropertiesOfType(type)) {
    const inner = functionIn(checker, inSrc, checker.getTypeOfSymbol(prop), seen);
    if (inner !== null) return `.${prop.name}${inner}`;
  }
  return null;
}

/** `file:line` of `node`, relative to `root`. */
function siteOf(root, node) {
  const sf = node.getSourceFile();
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return `${relative(root, sf.fileName).split(sep).join('/')}:${line}`;
}

/** Each parameter that holds a function in any of `method`'s overloads, at the overload that takes it. */
function methodHits(checker, inSrc, root, label, method) {
  const fallback = method.valueDeclaration ?? method.declarations?.[0];
  const hits = [];
  for (const signature of checker.getTypeOfSymbol(method).getCallSignatures()) {
    const at = signature.getDeclaration() ?? fallback;
    for (const param of signature.parameters) {
      const path = functionIn(checker, inSrc, checker.getTypeOfSymbol(param), new Set());
      if (path !== null && at !== undefined) hits.push(`${siteOf(root, at)} ${label}(${param.name}${path})`);
    }
  }
  return hits;
}

/** Whether `root` is hippo-memory's own folder, where a scan that reads no tier has checked nothing. */
function isHippoRepo(root) {
  const pkg = resolve(root, 'package.json');
  return existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'hippo-memory';
}

const unread = (why) => ({ sites: [], unread: [why] });

/** `sites`: `file:line repo.method(param.path)` for each local-tier method parameter whose type holds a function, read
 * from the type hippoDbRepos returns. `unread`: why the scan could not read the tier, so it checked nothing. */
export function tierFunctionParams(root = '.') {
  const door = resolve(root, TIER_DOOR);
  if (!existsSync(door)) return isHippoRepo(root) ? unread(`${TIER_DOOR} is missing`) : { sites: [], unread: [] };
  const src = posix(resolve(root, 'src')) + '/';
  const inSrc = (decl) => posix(decl.getSourceFile().fileName).startsWith(src);
  const program = ts.createProgram([door], OPTIONS);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(door);
  const repos = sf && checker.getSymbolAtLocation(sf)?.exports?.get(REPOS);
  if (repos === undefined) return unread(`${TIER_DOOR}:1 exports no ${REPOS}`);
  const [build] = checker.getTypeOfSymbol(repos).getCallSignatures();
  const tier = build === undefined ? [] : checker.getPropertiesOfType(checker.getReturnTypeOfSignature(build));
  const methodsOf = (repo) => checker.getPropertiesOfType(checker.getTypeOfSymbol(repo));
  // An `any` or empty type reads as nothing to check, which in hippo-memory means the scan is blind to it.
  if (isHippoRepo(root)) {
    if (tier.length === 0) return unread(`${TIER_DOOR}:1 ${REPOS}() returns no repository the checker can read`);
    const blind = tier.filter((repo) => methodsOf(repo).length === 0);
    const why = (repo) => `${TIER_DOOR}:1 ${REPOS}().${repo.name} has no method the checker can read`;
    if (blind.length > 0) return { sites: [], unread: blind.map(why) };
  }
  const sites = tier.flatMap((repo) =>
    methodsOf(repo).flatMap((method) => methodHits(checker, inSrc, root, `${repo.name}.${method.name}`, method)),
  );
  return { sites, unread: [] };
}
