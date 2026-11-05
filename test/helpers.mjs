/**
 * Utilità condivise dai test. I test girano sul JavaScript compilato in dist/,
 * quindi lancia `npm run build` prima di `npm test`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = join(TEST_DIR, "..");
export const DIST = join(PROJECT_DIR, "dist");

let passed = 0;
let failed = 0;

export function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log("  ok  -", message);
  } else {
    failed += 1;
    console.error("  FAIL-", message);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary(suiteName) {
  console.log(`\n${suiteName}: ${passed} ok, ${failed} falliti`);
  if (failed > 0) process.exitCode = 1;
  return failed === 0;
}

/**
 * Registra i tool senza dipendere dall'SDK MCP: espone la stessa interfaccia
 * `registerTool` usata da McpServer e conserva i tool in una Map ispezionabile.
 */
export function createRecorder() {
  return {
    tools: new Map(),
    registerTool(name, cfg, cb) {
      this.tools.set(name, { cfg, cb });
    },
    async connect() {},
  };
}

export async function registerAll(recorder) {
  const { registerOrgTools } = await import(`${DIST}/tools/orgs.js`);
  const { registerQueryTools } = await import(`${DIST}/tools/query.js`);
  const { registerSchemaTools } = await import(`${DIST}/tools/schema.js`);
  registerOrgTools(recorder);
  registerQueryTools(recorder);
  registerSchemaTools(recorder);
  return recorder;
}

/** Invoca l'handler di un tool come farebbe il client MCP. */
export function caller(recorder, { verbose = false } = {}) {
  return async (name, args = {}) => {
    const tool = recorder.tools.get(name);
    if (!tool) throw new Error(`Tool non registrato: ${name}`);
    const result = await tool.cb(args);
    if (verbose && result.isError) {
      console.log("      [errore restituito]", result.content[0].text.split("\n")[0]);
    }
    return result;
  };
}
