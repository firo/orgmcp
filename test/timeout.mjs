/**
 * Verifica che una Salesforce CLI che non risponde produca un errore spiegato
 * dal server, e non un generico timeout del client MCP.
 *
 * Gira in un processo separato perché la configurazione e il percorso della CLI
 * vengono risolti una sola volta, al primo import.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLI installata e funzionante (risponde a --version), ma che si blocca sui
// comandi che contattano l'org: è il caso di un'org non più raggiungibile.
const dir = mkdtempSync(join(tmpdir(), "orgmcp-timeout-"));
const hangingSf = join(dir, "sf");
writeFileSync(
  hangingSf,
  `#!/bin/bash
case "$*" in
  *--version*) echo "@salesforce/cli/2.99.0 test node-v20.0.0" ;;
  *) sleep 60 ;;
esac
`,
  "utf8",
);
chmodSync(hangingSf, 0o755);

process.env.ORGMCP_SF_PATH = hangingSf;
process.env.ORGMCP_CLI_TIMEOUT = "2";
process.env.ORGMCP_AUTH_TIMEOUT = "2";

const { assert, caller, createRecorder, registerAll, section, summary } = await import(
  "./helpers.mjs"
);

const call = caller(await registerAll(createRecorder()));

section("CLI che non risponde");
const started = Date.now();
const res = await call("sf_list_orgs", { checkConnection: false, connectedOnly: false });
const elapsed = Date.now() - started;

assert(res.isError, "un comando appeso produce un errore invece di restare in attesa");
assert(elapsed < 20_000, `il server interrompe il comando da solo (${elapsed} ms)`);
assert(
  /non ha risposto entro/.test(res.content[0].text),
  "il messaggio dice che la CLI non ha risposto entro il timeout",
);
assert(
  /refresh token|raggiungibile/.test(res.content[0].text),
  "il messaggio elenca le cause probabili",
);
assert(/sf_login/.test(res.content[0].text), "il messaggio indica come rimediare");

console.log("\n  messaggio prodotto:\n" + res.content[0].text.split("\n").map((l) => `    ${l}`).join("\n"));

summary("timeout");
