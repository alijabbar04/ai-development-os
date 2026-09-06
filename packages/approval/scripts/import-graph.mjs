// Already pinned in the repository's coverage-tool dependency closure.
import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/** Parse executable import topology, including dynamic imports and re-exports.
 * Computed loading is refused because a finite literal graph cannot prove it. */
export function importEdges(source, filename = "module.js") {
  const parsed = parse(source, { sourceType: "module", sourceFilename: filename, createImportExpressions: true });
  const edges = [];
  function literal(node, kind) {
    if (node?.type === "StringLiteral") edges.push({ specifier: node.value, kind });
    else if (node?.type === "TemplateLiteral" && node.expressions.length === 0) edges.push({ specifier: node.quasis[0].value.cooked, kind });
    else throw new Error("Computed import cannot be verified.");
  }
  function visit(node) {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      if (node.source) literal(node.source, "static");
    } else if (node.type === "ImportExpression") {
      literal(node.source, "dynamic");
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      if (node.arguments.length !== 1) throw new Error("Computed import cannot be verified.");
      literal(node.arguments[0], "dynamic");
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval"
      || node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Function") {
      throw new Error("Runtime-generated code cannot be verified.");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child !== null && typeof child?.type === "string") visit(child); }
      else if (value !== null && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  }
  visit(parsed);
  return edges;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && resolve(root, rel) === path;
}

export function inspectProductionGraph(approvalRoot, projectRoot, readSource = (file) => readFileSync(file, "utf8")) {
  const roots = [resolve(approvalRoot, "dist"), resolve(projectRoot, "dist")];
  const pending = [resolve(roots[0], "index.js")], visited = new Set();
  let bytes = 0, staticEdges = 0, dynamicEdges = 0;
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    if (file.replaceAll("\\", "/").toLowerCase().split("/").includes("testing")) throw new Error("Forbidden testing reachability.");
    if (!roots.some((root) => inside(root, file)) || !file.endsWith(".js")) throw new Error("Production graph escaped its allowed roots.");
    if (visited.size >= 200) throw new Error("Production graph exceeds its file bound.");
    const source = readSource(file); bytes += Buffer.byteLength(source);
    if (bytes > 2 * 1024 * 1024) throw new Error("Production graph exceeds its byte bound.");
    visited.add(file);
    for (const { specifier, kind } of importEdges(source, file)) {
      if (kind === "dynamic") dynamicEdges++; else staticEdges++;
      if (specifier === "@ai-dev-os/project") pending.push(resolve(roots[1], "index.js"));
      else if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else throw new Error(`Forbidden production dependency: ${specifier}`);
    }
  }
  return { files: [...visited], staticEdges, dynamicEdges };
}

/** Run against the actual packed root, altering only the reader's in-memory
 * bytes. A scanner which simply returns success fails these controls. */
export function assertForbiddenTestingControls(approvalRoot, projectRoot) {
  const entry = resolve(approvalRoot, "dist/index.js"), bridge = resolve(approvalRoot, "dist/planted.js");
  const original = readFileSync(entry, "utf8");
  for (const planted of ['export * from "./testing/index.js";', 'import("./testing/index.js");', 'import("./planted.js");']) {
    let detected = false;
    try {
      inspectProductionGraph(approvalRoot, projectRoot, (file) => file === entry ? `${original}\n${planted}`
        : file === bridge ? 'import("./testing/index.js");' : readFileSync(file, "utf8"));
    } catch (error) { if (error.message === "Forbidden testing reachability.") detected = true; else throw error; }
    if (!detected) throw new Error("The planted forbidden-testing control escaped detection.");
  }
}
