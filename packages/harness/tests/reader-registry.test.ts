import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "../../../node_modules/.bun/typescript@5.9.3/node_modules/typescript";
import { z } from "zod";
import { schemaEdges, transformingInput } from "@neuve/records-schema";

const root = resolve(import.meta.dir, "../../..");

/**
 * Computed `import()`s the walk can't follow, each read here and named with why it adds no reader
 * root. Any other computed import is unclassified, and an entry whose call is gone fails too.
 */
const COMPUTED_IMPORTS: Record<string, string> = {
  'apps/neuve-cli/src/review-desk.ts: import(pathToFileURL(join(desk.directory, "server/server.js")).href)':
    "the review desk's server bundle (build-desk.ts), built from this checkout at this CLI's version (desk.json must match it) and checked by its own serverEntry shape. Its Records and Graph reads are the records-core, harness and graph-client readers this registry already walks, bundled in; the rest is the web app's",
};

// Discover schema arguments and schema-valued registries from source, including generic readers.
// Test-only exports expose private roots without duplicating any production schema definition.
const readerRoots = async () => {
  const files = [
    "packages/records-schema/src",
    "packages/records-core/src",
    "packages/harness/src",
    "packages/graph-client/src",
    "apps/neuve-cli/src",
  ].flatMap((folder) => [
    ...new Bun.Glob("**/*.ts").scanSync({
      cwd: join(root, folder),
      absolute: true,
    }),
  ]);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: ["bun"],
    baseUrl: root,
    paths: {
      "@neuve/records-schema": ["packages/records-schema/src/index.ts"],
      "@neuve/records-core": ["packages/records-core/src/index.ts"],
      "@neuve/records-core/*": ["packages/records-core/src/*"],
      "@neuve/runtime": ["packages/runtime/src/index.ts"],
      "@neuve/harness": ["packages/harness/src/index.ts"],
      "@neuve/harness/*": ["packages/harness/src/*"],
    },
  });
  const checker = program.getTypeChecker();
  const expressions = new Set<ts.Expression>();
  const selected = new Map<string, Map<string, ts.Expression>>();
  const isSchema = (node: ts.Node) =>
    !!checker.getPropertyOfType(checker.getTypeAtLocation(node), "_zod");
  const declaration = (node: ts.Node) => {
    let symbol =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  const unclassified = (node: ts.Node): never => {
    throw new Error(
      `Unclassified reader root ${node.getSourceFile().fileName}: ${node.getText()}`,
    );
  };
  const parameterReaders = new Set<ts.Node>();
  const registrySource = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): ts.Expression => {
    if (seen.has(node)) return unclassified(node);
    seen.add(node);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "Object.entries" &&
      node.arguments.length === 1
    )
      return registrySource(node.arguments[0]!, seen);
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return registrySource(node.expression, seen);
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))
      return node;
    if (!ts.isIdentifier(node)) return unclassified(node);
    const decl = declaration(node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
      return decl.initializer;
    if (
      decl &&
      ts.isBindingElement(decl) &&
      (!decl.initializer ||
        (ts.isObjectLiteralExpression(decl.initializer) &&
          decl.initializer.properties.length === 0)) &&
      !decl.dotDotDotToken
    ) {
      const variable = decl.parent.parent;
      if (
        ts.isVariableDeclaration(variable) &&
        ts.isVariableDeclarationList(variable.parent) &&
        ts.isForOfStatement(variable.parent.parent)
      )
        return registrySource(variable.parent.parent.expression, seen);
    }
    return unclassified(node);
  };
  const resolveFactory = (
    fn: ts.Node,
    properties: ReadonlyArray<string>,
    seen: Set<ts.Node>,
    optional: boolean,
    consume: (node: ts.Expression, seen: Set<ts.Node>) => void,
  ): void => {
    if (ts.isIdentifier(fn)) {
      const decl = declaration(fn);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return resolveFactory(
          decl.initializer,
          properties,
          seen,
          optional,
          consume,
        );
    }
    if (ts.isPropertyAccessExpression(fn))
      return resolveProperty(
        fn.expression,
        [fn.name.text],
        seen,
        false,
        (factory, visited) =>
          resolveFactory(factory, properties, visited, optional, consume),
      );
    if (
      !ts.isArrowFunction(fn) &&
      !ts.isFunctionDeclaration(fn) &&
      !ts.isFunctionExpression(fn)
    )
      return unclassified(fn);
    const body = fn.body;
    if (!body || seen.has(body)) return unclassified(fn);
    const visited = new Set(seen).add(body);
    if (!ts.isBlock(body))
      return resolveProperty(body, properties, visited, optional, consume);
    let found = false;
    const visit = (item: ts.Node) => {
      if (ts.isFunctionLike(item)) return;
      if (ts.isReturnStatement(item)) {
        if (!item.expression) return unclassified(item);
        resolveProperty(
          item.expression,
          properties,
          visited,
          optional,
          consume,
        );
        found = true;
      } else ts.forEachChild(item, visit);
    };
    visit(body);
    if (!found) return unclassified(fn);
  };
  const resolveProperty = (
    node: ts.Expression,
    properties: ReadonlyArray<string>,
    seen: Set<ts.Node>,
    optional = false,
    consume: (node: ts.Expression, seen: Set<ts.Node>) => void = resolveRoot,
  ): void => {
    const [property, ...rest] = properties;
    if (!property) return consume(node, seen);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    )
      return resolveProperty(
        node.expression,
        properties,
        seen,
        optional,
        consume,
      );
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return resolveProperty(
          decl.initializer,
          properties,
          seen,
          optional,
          consume,
        );
      if (decl && (ts.isParameter(decl) || ts.isBindingElement(decl)))
        return resolveParameter(decl, seen, properties, consume);
    }
    if (ts.isObjectLiteralExpression(node)) {
      let found = false;
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) {
          const type = checker.getTypeAtLocation(item.expression);
          if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
            return unclassified(item);
          if (checker.getPropertyOfType(type, property)) {
            resolveProperty(
              item.expression,
              properties,
              new Set(seen),
              false,
              consume,
            );
            found = true;
          }
          continue;
        }
        if (item.name && ts.isComputedPropertyName(item.name))
          return unclassified(item);
        if (item.name?.getText().replace(/^['"]|['"]$/g, "") !== property)
          continue;
        if (ts.isPropertyAssignment(item))
          resolveProperty(
            item.initializer,
            rest,
            new Set(seen),
            false,
            consume,
          );
        else if (
          ts.isShorthandPropertyAssignment(item) &&
          !item.objectAssignmentInitializer
        )
          resolveProperty(item.name, rest, new Set(seen), false, consume);
        else return unclassified(item);
        found = true;
      }
      if (!found && !optional) return unclassified(node);
      return;
    }
    if (ts.isCallExpression(node)) {
      const decl = target(node);
      if (
        decl &&
        ts.isPropertySignature(decl) &&
        decl.name.getText() === "run" &&
        decl.getSourceFile().fileName.endsWith("/pi/stages/services.ts") &&
        node.arguments[0]
      )
        return resolveProperty(
          node.arguments[0],
          properties,
          seen,
          optional,
          consume,
        );
      if (
        decl &&
        ts.isPropertySignature(decl) &&
        ts.isPropertyAccessExpression(node.expression)
      )
        return resolveProperty(
          node.expression.expression,
          [node.expression.name.text],
          seen,
          false,
          (factory, visited) =>
            resolveFactory(factory, properties, visited, optional, consume),
        );
      // This private cache returns the maker's value, including values from earlier
      // calls. Pin its implementation so a changed carrier fails classification.
      if (
        decl &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer)
      ) {
        const cache = target(decl.initializer);
        if (
          cache &&
          ts.isVariableDeclaration(cache) &&
          cache.name.getText() === "cached" &&
          cache.getSourceFile().fileName.endsWith("/pi/stages/run.ts") &&
          createHash("sha256").update(cache.getText()).digest("hex") ===
            "fd581ea7cb5a11a695de161e8384c62c2aa97eaf3f9ad8afa0ad2012beed27f2" &&
          node.arguments[1]
        )
          return resolveFactory(
            node.arguments[1],
            properties,
            seen,
            optional,
            consume,
          );
      }
      const fn =
        decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
      if (
        node.expression.getText() === "Effect.gen" &&
        node.arguments[0] &&
        ts.isFunctionExpression(node.arguments[0])
      )
        return resolveFactory(
          node.arguments[0],
          properties,
          seen,
          optional,
          consume,
        );
      if (
        fn &&
        (ts.isArrowFunction(fn) ||
          ts.isFunctionDeclaration(fn) ||
          ts.isFunctionExpression(fn))
      )
        return resolveFactory(fn, properties, seen, optional, consume);
    }
    return unclassified(node);
  };
  const resolveParameter = (
    decl: ts.ParameterDeclaration | ts.BindingElement,
    seen: Set<ts.Node>,
    properties: ReadonlyArray<string> = [],
    consume: (node: ts.Expression, seen: Set<ts.Node>) => void = resolveRoot,
  ): void => {
    let parameter: ts.Node = decl;
    if (ts.isBindingElement(decl)) {
      if (
        (decl.initializer &&
          !(
            ts.isObjectLiteralExpression(decl.initializer) &&
            decl.initializer.properties.length === 0
          )) ||
        decl.dotDotDotToken ||
        !ts.isIdentifier(decl.name)
      )
        return unclassified(decl);
      if (
        decl.propertyName &&
        !ts.isIdentifier(decl.propertyName) &&
        !ts.isStringLiteral(decl.propertyName)
      )
        return unclassified(decl);
      properties = [decl.propertyName?.text ?? decl.name.text, ...properties];
      parameter = decl.parent.parent;
      if (ts.isVariableDeclaration(parameter) && parameter.initializer)
        return resolveProperty(
          parameter.initializer,
          properties,
          seen,
          false,
          consume,
        );
      if (
        ts.isVariableDeclaration(parameter) &&
        ts.isVariableDeclarationList(parameter.parent) &&
        ts.isForOfStatement(parameter.parent.parent)
      ) {
        const source = registrySource(parameter.parent.parent.expression);
        let found = false;
        const visit = (item: ts.Node) => {
          if (
            ts.isSpreadAssignment(item) ||
            (ts.isPropertyAssignment(item) &&
              ts.isComputedPropertyName(item.name))
          )
            return unclassified(item);
          if (ts.isPropertyAssignment(item) && isSchema(item.initializer)) {
            resolveRoot(item.initializer, new Set(seen));
            found = true;
            return;
          }
          if (ts.isArrayLiteralExpression(item))
            for (const element of item.elements) {
              if (ts.isSpreadElement(element)) return unclassified(element);
              if (isSchema(element)) {
                resolveRoot(element, new Set(seen));
                found = true;
              }
            }
          ts.forEachChild(item, visit);
        };
        visit(source);
        if (!found) return unclassified(source);
        return;
      }
    }
    if (
      !ts.isParameter(parameter) ||
      (parameter.initializer &&
        !(
          properties.length &&
          ts.isObjectLiteralExpression(parameter.initializer) &&
          parameter.initializer.properties.length === 0
        )) ||
      parameter.dotDotDotToken
    )
      return unclassified(parameter);
    const fn = parameter.parent;
    if (!ts.isFunctionLike(fn)) return unclassified(fn);
    const owner = ts.isVariableDeclaration(fn.parent) ? fn.parent : fn;
    parameterReaders.add(owner);
    const property = properties[0];
    const optionalProperty =
      property &&
      checker.getPropertyOfType(checker.getTypeAtLocation(parameter), property);
    const optional = !!(
      optionalProperty && optionalProperty.flags & ts.SymbolFlags.Optional
    );
    const index = fn.parameters.indexOf(parameter);
    const sites = callSites(owner);
    // No supplied schema is a root until there is a caller. The reference audit
    // below rejects escaped or aliased uses, including otherwise hidden callers.
    if (!sites.length) return;
    for (const call of sites) {
      const argument = call.arguments[index];
      if (!argument && optional) continue;
      if (!argument || ts.isSpreadElement(argument)) return unclassified(call);
      if (!properties.length) consume(argument, new Set(seen));
      else
        resolveProperty(argument, properties, new Set(seen), optional, consume);
    }
    return;
  };
  const resolveRoot = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): void => {
    if (seen.has(node)) return unclassified(node);
    seen.add(node);
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return resolveRoot(node.expression, seen);
    if (ts.isConditionalExpression(node)) {
      for (const branch of [node.whenTrue, node.whenFalse])
        if (!(ts.isIdentifier(branch) && branch.text === "undefined"))
          resolveRoot(branch, new Set(seen));
      return;
    }
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return resolveRoot(decl.initializer, seen);
      if (decl && (ts.isParameter(decl) || ts.isBindingElement(decl)))
        return resolveParameter(decl, seen);
      throw new Error(
        `Unclassified reader root ${node.getSourceFile().fileName}: ${node.getText()}`,
      );
    }
    if (
      ts.isElementAccessExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      // A locally selected registry contributes every real member, including future additions.
      const base = node.expression;
      if (ts.isIdentifier(base)) {
        const decl = declaration(base);
        if (
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          !isSchema(base)
        ) {
          let found = false;
          const visit = (child: ts.Node) => {
            if (ts.isPropertyAssignment(child) && isSchema(child.initializer)) {
              resolveRoot(child.initializer, new Set(seen));
              found = true;
            }
            if (
              ts.isSpreadAssignment(child) ||
              (ts.isPropertyAssignment(child) &&
                ts.isComputedPropertyName(child.name))
            )
              return unclassified(child);
            if (ts.isShorthandPropertyAssignment(child) && isSchema(child)) {
              const value =
                checker.getShorthandAssignmentValueSymbol(
                  child,
                )?.valueDeclaration;
              if (
                !value ||
                !ts.isVariableDeclaration(value) ||
                !value.initializer
              )
                return unclassified(child);
              resolveRoot(value.initializer, new Set(seen));
              found = true;
            }
            ts.forEachChild(child, visit);
          };
          visit(decl.initializer);
          if (!found) return unclassified(node);
          return;
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(base) &&
        base.name.text === "shape" &&
        isSchema(base.expression)
      )
        return resolveRoot(base.expression, seen);
      if (isSchema(base)) return resolveRoot(base, seen);
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return resolveRoot(decl.initializer, seen);
      if (
        decl &&
        ts.isPropertySignature(decl) &&
        ts.isIdentifier(base) &&
        ts.isPropertyAccessExpression(node)
      ) {
        const parameter = declaration(base);
        if (
          parameter &&
          (ts.isParameter(parameter) || ts.isBindingElement(parameter))
        )
          return resolveParameter(parameter, seen, [node.name.text]);
        return unclassified(node);
      }
      if (decl && ts.isPropertyAssignment(decl))
        return resolveRoot(decl.initializer, seen);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isSchema(node.expression.expression) &&
      [
        "optional",
        "nullable",
        "nullish",
        "readonly",
        "nonoptional",
        "array",
        "unwrap",
        // A size check keeps its base's shape, and its bound may be local (records' range hunks,
        // one per owned range): the base is the root.
        "length",
      ].includes(node.expression.name.text)
    )
      return resolveRoot(node.expression.expression, seen);
    // Evaluate only module-scope expressions. Local selections must resolve to a registry or parameter.
    let current: ts.Node = node;
    while (!ts.isSourceFile(current.parent)) {
      if (ts.isFunctionLike(current.parent)) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText() === "z"
        )
          break;
        throw new Error(
          `Unclassified local reader root: ${node.getSourceFile().fileName}: ${node.getText()}`,
        );
      }
      current = current.parent;
    }
    const file = node.getSourceFile().fileName;
    const list = selected.get(file) ?? new Map<string, ts.Expression>();
    list.set(node.getText(), node);
    selected.set(file, list);
  };
  const calls: ts.CallExpression[] = [];
  const owners = new Map<ts.CallExpression, ts.Node[]>();
  for (const file of files) {
    if (
      file.includes("/records-schema/") ||
      file.endsWith("/compatible-read.ts")
    )
      continue;
    const source = program.getSourceFile(file)!;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        calls.push(node);
        let parent: ts.Node | undefined = node.parent;
        const enclosing: ts.Node[] = [];
        while (parent) {
          if (ts.isFunctionLike(parent))
            enclosing.push(
              ts.isVariableDeclaration(parent.parent) ? parent.parent : parent,
            );
          parent = parent.parent;
        }
        owners.set(node, enclosing);
      }
      if (ts.isPropertyAssignment(node) && isSchema(node.initializer)) {
        let parent: ts.Node = node;
        while (
          parent.parent &&
          !ts.isFunctionLike(parent.parent) &&
          !ts.isSourceFile(parent.parent)
        ) {
          if (ts.isCallExpression(parent.parent) && isSchema(parent.parent))
            break;
          parent = parent.parent;
        }
        if (parent.parent && ts.isSourceFile(parent.parent))
          expressions.add(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const readers = new Set<ts.Node>();
  const target = (call: ts.CallExpression) => {
    let decl = declaration(
      ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name
        : ts.isElementAccessExpression(call.expression) &&
            ts.isStringLiteral(call.expression.argumentExpression)
          ? call.expression.argumentExpression
          : call.expression,
    );
    const seen = new Set<ts.Node>();
    while (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isIdentifier(decl.initializer) ||
        ts.isPropertyAccessExpression(decl.initializer))
    ) {
      if (seen.has(decl)) return unclassified(call);
      seen.add(decl);
      decl = declaration(
        ts.isPropertyAccessExpression(decl.initializer)
          ? decl.initializer.name
          : decl.initializer,
      );
    }
    return decl;
  };
  // An owner's call sites, filtered once from the complete call list and reused
  // for every parameter of that owner in this discovery run.
  const sitesByOwner = new Map<ts.Node, ts.CallExpression[]>();
  const callSites = (owner: ts.Node) => {
    let sites = sitesByOwner.get(owner);
    if (!sites) {
      sites = calls.filter((call) => target(call) === owner);
      sitesByOwner.set(owner, sites);
    }
    return sites;
  };
  const direct = (call: ts.CallExpression) => {
    const definition = target(call);
    return (
      definition &&
      ts.isVariableDeclaration(definition) &&
      definition.getSourceFile().fileName.endsWith("/compatible-read.ts") &&
      ["safeRead", "readData", "preserveUnknown"].includes(
        definition.name.getText(),
      )
    );
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls)
      if (direct(call) || (target(call) && readers.has(target(call)!))) {
        for (const owner of owners.get(call) ?? [])
          if (!readers.has(owner)) {
            readers.add(owner);
            changed = true;
          }
      }
  }
  for (const call of calls) {
    if (direct(call)) {
      const schema = call.arguments[0];
      if (!schema || ts.isSpreadElement(schema)) return unclassified(call);
      expressions.add(schema);
    }
    if (direct(call) || (target(call) && readers.has(target(call)!)))
      for (const argument of call.arguments) {
        if (isSchema(argument)) expressions.add(argument);
        if (ts.isObjectLiteralExpression(argument))
          for (const property of argument.properties)
            if (
              ts.isPropertyAssignment(property) &&
              isSchema(property.initializer)
            )
              expressions.add(property.initializer);
            else if (
              ts.isShorthandPropertyAssignment(property) &&
              isSchema(property.name)
            ) {
              const value =
                checker.getShorthandAssignmentValueSymbol(
                  property,
                )?.valueDeclaration;
              if (!value) return unclassified(property);
              if (ts.isVariableDeclaration(value) && value.initializer)
                expressions.add(value.initializer);
              else if (ts.isBindingElement(value))
                expressions.add(property.name);
              else return unclassified(property);
            }
      }
  }
  for (const expression of expressions) resolveRoot(expression);
  const containsReader = (node: ts.Node) => {
    const type = checker.getTypeAtLocation(node);
    return checker
      .getPropertiesOfType(checker.getAwaitedType(type) ?? type)
      .some((symbol) => {
        if (symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        const value = symbol.valueDeclaration ?? symbol.declarations?.[0];
        return (
          value &&
          (parameterReaders.has(value) ||
            (ts.isVariableDeclaration(value) &&
              value.getSourceFile().fileName.endsWith("/compatible-read.ts") &&
              ["safeRead", "readData", "preserveUnknown"].includes(
                value.name.getText(),
              )))
        );
      });
  };
  const computedImports = new Set<string>();
  for (const file of files) {
    if (
      file.includes("/records-schema/") ||
      file.endsWith("/compatible-read.ts")
    )
      continue;
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!node.arguments[0] ||
          !ts.isStringLiteral(node.arguments[0]) ||
          containsReader(node))
      ) {
        // On one line, as formatting may wrap it.
        const text = node
          .getText()
          .replace(/\s+/g, " ")
          .replace(/\( /g, "(")
          .replace(/ \)/g, ")");
        const site = `${relative(root, node.getSourceFile().fileName)}: ${text}`;
        if (COMPUTED_IMPORTS[site] === undefined) unclassified(node);
        computedImports.add(site);
      }
      if (ts.isElementAccessExpression(node) && containsReader(node.expression))
        unclassified(node);
      if (
        ts.isVariableDeclaration(node) &&
        !ts.isIdentifier(node.name) &&
        node.initializer &&
        containsReader(node.initializer)
      )
        unclassified(node);
      if (ts.isIdentifier(node)) {
        const decl = declaration(node);
        if (
          checker
            .getSymbolAtLocation(node)
            ?.declarations?.some(ts.isNamespaceImport)
        ) {
          if (containsReader(node)) {
            const parent = node.parent;
            const member =
              ts.isPropertyAccessExpression(parent) &&
              parent.expression === node;
            if (!ts.isNamespaceImport(parent) && !member) unclassified(node);
          }
        }
        const reader =
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.getSourceFile().fileName.endsWith("/compatible-read.ts") &&
          ["safeRead", "readData", "preserveUnknown"].includes(
            decl.name.getText(),
          );
        if (reader || (decl && parameterReaders.has(decl))) {
          const parent = node.parent;
          const callable =
            ts.isPropertyAccessExpression(parent) && parent.name === node
              ? parent
              : node;
          const called =
            ts.isCallExpression(callable.parent) &&
            callable.parent.expression === callable;
          const declared =
            (ts.isVariableDeclaration(parent) ||
              ts.isFunctionDeclaration(parent)) &&
            parent.name === node;
          const imported =
            ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
          if (!called && !declared && !imported) unclassified(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(file)!);
  }
  for (const site of Object.keys(COMPUTED_IMPORTS))
    if (!computedImports.has(site))
      throw new Error(`Named computed import no longer found: ${site}`);
  const folder = await mkdtemp(join(tmpdir(), "reader-registry-"));
  try {
    const entry =
      [...selected]
        .map(
          ([file], index) =>
            `import { __readerRoots as r${index} } from ${JSON.stringify(file)};`,
        )
        .join("\n") +
      `\nexport default [${[...selected].map((_, index) => `...r${index}`).join(",")}];`;
    await writeFile(join(folder, "entry.ts"), entry);
    await symlink(join(root, "node_modules"), join(folder, "node_modules"));
    const built = await Bun.build({
      entrypoints: [join(folder, "entry.ts")],
      target: "bun",
      format: "esm",
      outdir: folder,
      plugins: [
        {
          name: "real-reader-roots",
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, (args) =>
              args.path.startsWith("@neuve/")
                ? undefined
                : {
                    path: Bun.resolveSync(args.path, args.resolveDir),
                    external: true,
                  },
            );
            build.onLoad({ filter: /\.ts$/ }, async (args) => {
              if (
                !args.path.startsWith(root) ||
                args.path.includes("node_modules")
              )
                return;
              const roots = selected.get(args.path);
              if (!roots) return;
              return {
                loader: "ts",
                contents:
                  (await readFile(args.path, "utf8")) +
                  `\nexport const __readerRoots = [${[...roots.keys()].map((expression) => `{name:${JSON.stringify(relative(root, args.path) + ":" + expression)},schema:(${expression})}`).join(",")}];`,
              };
            });
          },
        },
      ],
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const artifact = join(folder, "audit.mjs");
    await writeFile(artifact, await built.outputs[0]!.text());
    await rm(join(folder, "entry.ts"));
    const loaded: unknown = (await import(artifact)).default;
    if (!Array.isArray(loaded)) throw new Error("Unclassified reader registry");
    return loaded.map((item: unknown) =>
      z
        .object({ name: z.string(), schema: z.instanceof(z.core.$ZodType) })
        .parse(item),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const audit = (
  schema: z.core.$ZodType,
  name: string,
  seen = new Set<z.core.$ZodType>(),
) => {
  if (seen.has(schema)) return;
  seen.add(schema);
  const descendants = (
    value: z.core.$ZodType,
    visited = new Set<z.core.$ZodType>(),
  ): boolean => {
    if (visited.has(value)) return false;
    visited.add(value);
    return (
      (value instanceof z.ZodObject &&
        (!value.def.catchall || value.def.catchall instanceof z.ZodNever)) ||
      value instanceof z.ZodRecord ||
      schemaEdges(value).some((child) => descendants(child, visited))
    );
  };
  if (
    schema instanceof z.ZodCodec &&
    schemaEdges(schema).some((child) => descendants(child))
  )
    throw new Error(`${name}: codec`);
  if (
    schema instanceof z.ZodPipe &&
    transformingInput(schema.in) &&
    schemaEdges(schema).some((child) => descendants(child))
  )
    throw new Error(`${name}: transforming-pipe`);
  // Object and container aliases can diverge only where the input domains overlap.
  if (
    schema instanceof z.ZodUnion &&
    !(schema instanceof z.ZodDiscriminatedUnion)
  ) {
    const domain = (
      value: z.core.$ZodType,
      visited = new Set<z.core.$ZodType>(),
    ): ReadonlySet<string> => {
      if (visited.has(value)) return new Set(["any"]);
      visited.add(value);
      if (value instanceof z.ZodObject || value instanceof z.ZodRecord)
        return new Set(["object"]);
      if (value instanceof z.ZodArray || value instanceof z.ZodTuple)
        return new Set(["array"]);
      if (value instanceof z.ZodMap) return new Set(["map"]);
      if (value instanceof z.ZodSet) return new Set(["set"]);
      if (value instanceof z.ZodUnion)
        return new Set(
          value.options.flatMap((child) => [
            ...domain(child, new Set(visited)),
          ]),
        );
      if (value instanceof z.ZodPipe) return domain(value.in, visited);
      if ("unwrap" in value && typeof value.unwrap === "function")
        return domain(value.unwrap(), visited);
      if (
        ["unknown", "any", "custom", "intersection", "transform"].includes(
          value._zod.def.type,
        )
      )
        return new Set(["any"]);
      return new Set();
    };
    for (let index = 0; index < schema.options.length; index++)
      for (const other of schema.options.slice(index + 1)) {
        const option = schema.options[index]!;
        const leftDomain = domain(option),
          rightDomain = domain(other);
        const overlaps =
          [...leftDomain].some(
            (kind) => rightDomain.has(kind) || rightDomain.has("any"),
          ) ||
          (leftDomain.has("any") && rightDomain.size > 0);
        const disjoint =
          option instanceof z.ZodObject &&
          other instanceof z.ZodObject &&
          Object.keys(option.shape).some((key) => {
            const left = option.shape[key]?._zod.values,
              right = other.shape[key]?._zod.values;
            return (
              left && right && ![...left].some((value) => right.has(value))
            );
          });
        if (
          overlaps &&
          !disjoint &&
          (descendants(option) || descendants(other))
        )
          throw new Error(`${name}: diverging-alias`);
      }
  }
  for (const child of schemaEdges(schema)) audit(child, name, seen);
};

test("real cross-build reader roots and registries contain zero refused shapes and every root is classified", async () => {
  const roots = await readerRoots();
  console.info(`Reader registry: ${roots.length} roots`);
  expect(roots.length).toBeGreaterThan(80);
  for (const file of [
    "packages/harness/src/index-snapshot.ts",
    "packages/harness/src/stack/index-meta.ts",
    "packages/harness/src/search-index.ts",
    "packages/harness/src/graph-outline.ts",
    "packages/graph-client/src/symbols.ts",
    "packages/graph-client/src/tokens.ts",
    "packages/graph-client/src/snapshot.ts",
  ])
    expect(roots.some((root) => root.name.startsWith(`${file}:`))).toBe(true);
  // A reader root added to the Graph client without being looked at is how a shape that refuses
  // another build's data gets in, so its roots are pinned per file. Each reads engine output that
  // another engine build may have written:
  // - symbols.ts (4): the symbols stream header; the envelope of a plain read; the envelope of a
  //   read that asked for tokens; the symbol, file outline and summary record body.
  // - tokens.ts (1): the `file_tokens` record body (`TokensWire`, read as `streamSchemas.tokens`).
  // - snapshot.ts (2): the compact snapshot's header; its summary record.
  const graphClientRoots: Record<string, number> = {};
  for (const { name } of roots)
    if (name.startsWith("packages/graph-client/src/")) {
      const file = name.slice(0, name.indexOf(":"));
      graphClientRoots[file] = (graphClientRoots[file] ?? 0) + 1;
    }
  expect(graphClientRoots).toEqual({
    "packages/graph-client/src/symbols.ts": 4,
    "packages/graph-client/src/tokens.ts": 1,
    "packages/graph-client/src/snapshot.ts": 2,
  });
  for (const { name, schema } of roots) audit(schema, name);
}, 60_000);
