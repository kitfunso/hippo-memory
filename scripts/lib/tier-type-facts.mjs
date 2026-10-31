// The worker-crossing scan of hippo.db's local tier for check-store-port.mjs. The tier has no port interface to read,
// so the TypeScript checker reads each repository's method types as hippoDbRepos infers them from its bodies.
import { existsSync } from 'node:fs';
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

/** The path to the first function `type` holds ('' when it is one), or null when it is data. A type declared outside
 * src is data; a src type is read through its properties, unions, intersections and array elements. */
function functionIn(checker, inSrc, type, seen) {
  if (seen.has(type)) return null;
  seen.add(type);
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return '';
  const parts = type.isUnionOrIntersection()
    ? type.types
    : checker.isArrayType(type) || checker.isTupleType(type)
      ? checker.getTypeArguments(type)
      : undefined;
  if (parts !== undefined) {
    for (const part of parts) {
      const inner = functionIn(checker, inSrc, part, seen);
      if (inner !== null) return inner;
    }
    return null;
  }
  const decls = (type.aliasSymbol ?? type.getSymbol())?.declarations ?? [];
  if ((type.flags & ts.TypeFlags.Object) === 0 || !decls.some(inSrc)) return null;
  for (const prop of checker.getPropertiesOfType(type)) {
    const inner = functionIn(checker, inSrc, checker.getTypeOfSymbol(prop), seen);
    if (inner !== null) return `.${prop.name}${inner}`;
  }
  return null;
}

/** `file:line repo.method(param.path)` for each parameter of a local-tier method whose type holds a function, read
 * from the type hippoDbRepos returns; [] when `root` has no tier door. */
export function tierFunctionParams(root = '.') {
  const door = resolve(root, TIER_DOOR);
  if (!existsSync(door)) return [];
  const src = posix(resolve(root, 'src')) + '/';
  const inSrc = (decl) => posix(decl.getSourceFile().fileName).startsWith(src);
  const program = ts.createProgram([door], OPTIONS);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(door);
  const repos = sf && checker.getSymbolAtLocation(sf)?.exports?.get(REPOS);
  if (repos === undefined) return [`${TIER_DOOR}:1 exports no ${REPOS} to read the tier from`];
  const [build] = checker.getTypeOfSymbol(repos).getCallSignatures();
  const hits = [];
  for (const repo of checker.getPropertiesOfType(checker.getReturnTypeOfSignature(build))) {
    for (const method of checker.getPropertiesOfType(checker.getTypeOfSymbol(repo))) {
      const decl = method.valueDeclaration ?? method.declarations?.[0];
      const [signature] = checker.getTypeOfSymbol(method).getCallSignatures();
      for (const param of signature?.parameters ?? []) {
        const path = functionIn(checker, inSrc, checker.getTypeOfSymbol(param), new Set());
        if (path === null || decl === undefined) continue;
        const at = decl.getSourceFile();
        const line = at.getLineAndCharacterOfPosition(decl.getStart(at)).line + 1;
        const file = relative(root, at.fileName).split(sep).join('/');
        hits.push(`${file}:${line} ${repo.name}.${method.name}(${param.name}${path})`);
      }
    }
  }
  return hits;
}
