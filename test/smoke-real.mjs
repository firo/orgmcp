/**
 * Prova di fumo contro una org REALE. Sola lettura, nessun dato di clienti:
 * interroga solo metadati della org, schema e conteggi aggregati.
 *
 *   node test/smoke-real.mjs [alias]
 *
 * Richiede `npm run build` e un'org già autorizzata (`sf org login web --alias <alias>`).
 */
import { caller, createRecorder, registerAll } from "./helpers.mjs";

const alias = process.argv[2] ?? process.env.ORGMCP_DEFAULT_ORG ?? "myorg";

const recorder = await registerAll(createRecorder());
const call = caller(recorder);

let failures = 0;

async function step(title, name, args = {}, render = (d) => d, { optional = false } = {}) {
  process.stdout.write(`\n▸ ${title}${optional ? " (facoltativo)" : ""}\n`);
  const started = Date.now();
  const res = await call(name, args);
  const ms = Date.now() - started;
  if (res.isError) {
    if (!optional) failures += 1;
    console.log(`  ${optional ? "–" : "✗"} (${ms} ms)`);
    console.log(
      res.content[0].text
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
    return null;
  }
  console.log(`  ✓ (${ms} ms)`);
  const shown = render(res.structuredContent);
  if (shown !== undefined) {
    console.log(
      JSON.stringify(shown, null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
  return res.structuredContent;
}

console.log(`Prova di fumo sull'org "${alias}" — sola lettura, nessun dato di record.`);

await step("Prerequisiti", "sf_preflight", {}, (d) => ({
  cli: d.sfCli.version,
  binario: d.sfCli.binary,
  defaultOrg: d.config.defaultOrg,
  exportDir: d.config.exportDir,
}));

await step("Org autorizzate", "sf_list_orgs", { checkConnection: false, connectedOnly: false }, (d) => ({
  count: d.count,
  connessioneVerificata: d.connectionChecked,
  alias: d.orgs.map((o) => o.alias).filter(Boolean),
}));

await step("Informazioni della org", "sf_org_info", { org: alias, includeLimits: true }, (d) => ({
  orgName: d.orgName,
  orgId: d.orgId,
  tipo: d.organizationType,
  isSandbox: d.isSandbox,
  instance: d.instanceName,
  apiVersion: d.apiVersion,
  apiUsatePct: d.limits?.DailyApiRequests?.usedPct ?? null,
}));

await step(
  "Oggetti standard principali",
  "sf_describe_global",
  { org: alias, nameContains: "account", queryableOnly: true, customOnly: false, limit: 5 },
  (d) => ({ totalInOrg: d.totalInOrg, primi: d.sobjects.map((s) => s.name) }),
);

await step(
  "Schema di Account (solo i campi con 'name')",
  "sf_describe_object",
  {
    org: alias,
    sobject: "Account",
    fieldNameContains: "name",
    includePicklists: false,
    includeChildRelationships: false,
    fieldLimit: 10,
  },
  (d) => ({ campiTotali: d.fieldCount, mostrati: d.fields.map((f) => `${f.name} (${f.type})`) }),
);

await step(
  "Conteggio aggregato",
  "sf_soql",
  { org: alias, query: "SELECT COUNT() FROM Account", pageSize: 200, tooling: false },
  (d) => ({ accountNellaOrg: d.count }),
);

// EntityDefinition è leggibile da qualunque utente: verifica il percorso Tooling
// senza dipendere da permessi di setup. Niente LIMIT: non è supportato su questo oggetto.
await step(
  "Tooling API",
  "sf_soql",
  {
    org: alias,
    query: "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName = 'Account'",
    pageSize: 200,
    tooling: true,
  },
  (d) => ({ trovato: d.records.map((r) => `${r.QualifiedApiName} — ${r.Label}`) }),
);

// Richiede permessi di setup (Author Apex / View Setup): se manca, non è un errore del server.
await step(
  "Tooling API su oggetti di setup",
  "sf_soql",
  { org: alias, query: "SELECT Id, Name FROM ApexClass ORDER BY Name", pageSize: 200, tooling: true },
  (d) => ({ apexClassLette: d.returned, prima: d.records[0]?.Name ?? null }),
  { optional: true },
);

await step(
  "Limiti più consumati",
  "sf_limits",
  { org: alias, onlyUsed: true },
  (d) => d.limits.slice(0, 3),
);

console.log(
  failures === 0
    ? "\nTutti i passi completati.\n"
    : `\n${failures} passi falliti: leggi i messaggi sopra.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
