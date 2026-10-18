// Gate 1 kit: builds tools/gate1/check.html, one self-contained page that works when opened straight from disk.
//
// Why a bundle: a page opened from disk (file://) cannot rely on <script type="module" src=...> — Chrome refuses to
// load module scripts from file:// URLs, and the kit must not depend on what Safari happens to allow there. A single
// inline classic script works in every browser from disk, needs no server, and lets the page carry a strict
// Content-Security-Policy keyed to the exact script and style it holds (sha256 hashes), with every network fetch
// blocked (connect-src 'none').
//
// How: each ES module reachable from check.js becomes a function scope; `import { a, b as c } from './x.js'` becomes
// `const { a, b: c } = <x's exports>`, and `export` keywords are removed and collected into the scope's return value.
// Only the import and export forms the kit's modules use are understood; anything else (default exports, export *,
// side-effect imports, dynamic import, import.meta, cycles) stops the build with a message rather than producing a
// page that might not work. Run: node tools/gate1/build.js   (test/gate1.test.js checks check.html is current.)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const ENTRY = path.join(HERE, 'check.js');
export const TEMPLATE = path.join(HERE, 'check.template.html');
export const OUTPUT = path.join(HERE, 'check.html');
export const EXPECTED = path.join(HERE, 'expected.json');

const IMPORT_RE = /^import\s+([^;]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

/**
 * @typedef {object} Module
 * @property {string} file
 * @property {string} id
 * @property {Array<{spec: string, file: string, bindings: Array<{imported: string, local: string}>, namespace: string|null}>} imports
 * @property {Map<string, string>} exports   exported name -> local name
 * @property {string} body
 */

class BuildError extends Error {}

/**
 * @param {string} file
 * @returns {string}
 */
function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isIdentifier(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * Parses and rewrites one module.
 * @param {string} file
 * @param {string} source
 * @param {string} id
 * @returns {Module}
 */
export function transformModule(file, source, id) {
  const where = rel(file);
  // JSDoc types such as {import('../model.js').Item} live in comments, and words like "import (" can sit in strings;
  // look for dynamic import() outside both. (An approximation: the tests also run the bundle.)
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g, '""');
  if (/\bimport\s*\(/.test(code)) throw new BuildError(`${where}: dynamic import() is not supported in the bundle`);
  if (/\bimport\.meta\b/.test(source)) throw new BuildError(`${where}: import.meta is not supported in the bundle`);
  if (/^export\s+default\b/m.test(source)) throw new BuildError(`${where}: default exports are not supported`);
  if (/^export\s*\*/m.test(source)) throw new BuildError(`${where}: export * is not supported`);
  if (/^import\s+['"]/m.test(source)) throw new BuildError(`${where}: side-effect imports are not supported`);

  /** @type {Module['imports']} */
  const imports = [];
  let body = source.replace(IMPORT_RE, (_all, clause, _q, spec) => {
    const target = path.resolve(path.dirname(file), spec);
    if (!spec.startsWith('.')) throw new BuildError(`${where}: only relative imports are supported ("${spec}")`);
    const c = clause.trim();
    /** @type {Array<{imported: string, local: string}>} */
    const bindings = [];
    let namespace = null;
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(c);
    if (ns) namespace = ns[1];
    else {
      const named = /^\{([\s\S]*)\}$/.exec(c);
      if (!named) throw new BuildError(`${where}: unsupported import clause`);
      for (const part of named[1].split(',')) {
        const p = part.trim();
        if (p === '') continue;
        const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
        if (!m) throw new BuildError(`${where}: unsupported import binding "${p}"`);
        bindings.push({ imported: m[1], local: m[2] ?? m[1] });
      }
    }
    imports.push({ spec, file: target, bindings, namespace });
    return '';
  });

  /** @type {Map<string, string>} */
  const exports = new Map();
  body = body.replace(EXPORT_DECL_RE, (_all, kind, name) => {
    if (exports.has(name)) throw new BuildError(`${where}: "${name}" is exported twice`);
    exports.set(name, name);
    return `${kind} ${name}`;
  });
  body = body.replace(EXPORT_LIST_RE, (_all, list) => {
    for (const part of String(list).split(',')) {
      const p = part.trim();
      if (p === '') continue;
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
      if (!m) throw new BuildError(`${where}: unsupported export binding "${p}"`);
      const exported = m[2] ?? m[1];
      if (exports.has(exported)) throw new BuildError(`${where}: "${exported}" is exported twice`);
      exports.set(exported, m[1]);
    }
    return '';
  });
  const leftover = /^\s*(import|export)\b(?!\s*\()/m.exec(body);
  if (leftover) {
    const line = body.slice(0, leftover.index).split('\n').length;
    throw new BuildError(`${where}: an import or export the bundler does not understand is left near line ${line}`);
  }
  return { file, id, imports, exports, body };
}

/**
 * Loads every module reachable from the entry, dependencies first.
 * @param {string} entry
 * @param {(file: string) => string} [read]
 * @returns {Module[]}
 */
export function collectModules(entry, read = (f) => readFileSync(f, 'utf8')) {
  /** @type {Map<string, Module>} */
  const done = new Map();
  /** @type {Module[]} */
  const order = [];
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} file */
  const visit = (file) => {
    if (done.has(file)) return;
    if (visiting.has(file)) throw new BuildError(`import cycle through ${rel(file)}`);
    visiting.add(file);
    let source;
    try {
      source = read(file);
    } catch {
      throw new BuildError(`cannot read ${rel(file)}`);
    }
    const mod = transformModule(file, source, `__gate1_m${done.size}_${order.length}`);
    for (const imp of mod.imports) visit(imp.file);
    visiting.delete(file);
    mod.id = `__gate1_m${order.length}`;
    done.set(file, mod);
    order.push(mod);
  };
  visit(path.resolve(entry));
  // Every named import must exist in its target.
  for (const mod of order) {
    for (const imp of mod.imports) {
      const target = /** @type {Module} */ (done.get(imp.file));
      for (const b of imp.bindings) {
        if (!target.exports.has(b.imported)) throw new BuildError(`${rel(mod.file)} imports "${b.imported}", which ${rel(target.file)} does not export`);
      }
    }
  }
  return order;
}

/**
 * @param {Module[]} modules
 * @param {Map<string, Module>} byFile
 * @param {Module} mod
 * @returns {string}
 */
function wrap(modules, byFile, mod) {
  const head = mod.imports
    .map((imp) => {
      const target = /** @type {Module} */ (byFile.get(imp.file));
      if (imp.namespace) return `const ${imp.namespace} = ${target.id};`;
      return `const { ${imp.bindings.map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`)).join(', ')} } = ${target.id};`;
    })
    .join('\n');
  const ret = [...mod.exports].map(([exported, local]) => (exported === local ? local : `${exported}: ${local}`)).join(', ');
  return `// ---- ${rel(mod.file)}\nconst ${mod.id} = (function () {\n'use strict';\n${head}\n${mod.body.trim()}\nreturn Object.freeze({ ${ret} });\n})();\n`;
}

/**
 * The bundled script: every module, the expected data, and the start-up code.
 * @param {{ entry?: string, expectedJson?: string, read?: (file: string) => string }} [options]
 * @returns {{ js: string, modules: string[] }}
 */
export function buildBundle(options = {}) {
  const modules = collectModules(options.entry ?? ENTRY, options.read);
  const byFile = new Map(modules.map((m) => [m.file, m]));
  const expectedJson = options.expectedJson ?? readFileSync(EXPECTED, 'utf8');
  const expected = JSON.parse(expectedJson); // fail the build on bad JSON
  const entry = modules[modules.length - 1];
  for (const name of ['init', 'runCheck', 'selfTest']) {
    if (!entry.exports.has(name)) throw new BuildError(`${rel(entry.file)} must export ${name}`);
  }
  const js =
    '// Generated by tools/gate1/build.js from the modules listed below. Do not edit; edit the sources and rebuild.\n' +
    `// Modules: ${modules.map((m) => rel(m.file)).join(', ')}\n` +
    '(function () {\n' +
    "'use strict';\n" +
    modules.map((m) => wrap(modules, byFile, m)).join('\n') +
    `const GATE1_EXPECTED = ${JSON.stringify(expected)};\n` +
    `globalThis.Gate1 = Object.freeze(Object.assign({ EXPECTED: GATE1_EXPECTED }, ${entry.id}));\n` +
    "if (typeof document !== 'undefined') {\n" +
    `  const start = () => ${entry.id}.init(GATE1_EXPECTED);\n` +
    "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);\n" +
    '  else start();\n' +
    '}\n' +
    '})();\n';
  return { js, modules: modules.map((m) => rel(m.file)) };
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256Source(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * The finished page.
 * @param {{ template?: string, entry?: string, expectedJson?: string, read?: (file: string) => string }} [options]
 * @returns {{ html: string, js: string, scriptHash: string, styleHash: string, modules: string[] }}
 */
export function buildPage(options = {}) {
  const { js, modules } = buildBundle(options);
  // Text inside <script> must not close the element or open an HTML comment (both change how HTML parses it).
  if (/<\/script/i.test(js) || /<!--/.test(js)) throw new BuildError('the bundle contains "</script" or "<!--"; it cannot be inlined safely');
  const template = options.template ?? readFileSync(TEMPLATE, 'utf8');
  const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1) throw new BuildError('the template must hold exactly one <style> element');
  if (/\sstyle=/i.test(template)) throw new BuildError('the template must not use style attributes (the policy blocks them)');
  const placeholder = '<script>/*__GATE1_BUNDLE__*/</script>';
  if (template.split(placeholder).length !== 2) throw new BuildError('the template must hold the bundle placeholder exactly once');
  const scriptHash = sha256Source(js);
  const styleHash = sha256Source(styles[0][1]);
  if (!template.includes("'__SCRIPT_HASH__'") || !template.includes("'__STYLE_HASH__'")) throw new BuildError('the template policy placeholders are missing');
  const html = template
    .replace("'__SCRIPT_HASH__'", `'${scriptHash}'`)
    .replace("'__STYLE_HASH__'", `'${styleHash}'`)
    .replace(placeholder, () => `<script>${js}</script>`);
  return { html, js, scriptHash, styleHash, modules };
}

// Run directly: write check.html.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { html, modules } = buildPage();
    writeFileSync(OUTPUT, html);
    console.log(`Wrote ${rel(OUTPUT)} (${html.length} bytes) from ${modules.length} modules: ${modules.join(', ')}`);
  } catch (error) {
    console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
