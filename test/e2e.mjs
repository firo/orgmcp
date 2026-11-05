/**
 * Test end-to-end con una Salesforce CLI finta e un mock dell'API REST:
 * verifica autenticazione, cache del token, retry sul 401, paginazione,
 * describe, limiti ed export, senza toccare una org reale.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, caller, createRecorder, registerAll, section, summary } from "./helpers.mjs";

const work = mkdtempSync(join(tmpdir(), "orgmcp-e2e-"));
const counterFile = join(work, "token-calls");
const argsLog = join(work, "cli-args.log");
const fakeSf = join(work, "sf");

// --- Salesforce CLI finta: risponde in JSON come `sf --json` ---------------
writeFileSync(
  fakeSf,
  `#!/bin/bash
PORT="\${MOCK_PORT:-7788}"
COUNTER="\${MOCK_COUNTER}"
ARGS="$*"
echo "$ARGS" >> "\${MOCK_ARGS_LOG}"
case "$ARGS" in
  *"--version"*)
    # sf --version stampa testo semplice, non JSON
    echo "@salesforce/cli/2.99.0 darwin-arm64 node-v20.11.0" ;;
  *"org display"*)
    n=$(cat "$COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$COUNTER"
    if [ "$n" -eq 0 ]; then TOKEN="STALE"; else TOKEN="FRESH"; fi
    echo "{\\"status\\":0,\\"result\\":{\\"id\\":\\"00D000000000001EAA\\",\\"accessToken\\":\\"$TOKEN\\",\\"instanceUrl\\":\\"http://127.0.0.1:$PORT\\",\\"username\\":\\"user@example.com.sandbox\\",\\"alias\\":\\"myorg\\",\\"apiVersion\\":\\"67.0\\",\\"connectedStatus\\":\\"Connected\\"}}" ;;
  *"org list"*)
    echo '{"status":0,"result":{"nonScratchOrgs":[{"alias":"prodorg","username":"admin@example.com","orgId":"00D1","instanceUrl":"https://example.my.salesforce.com","connectedStatus":"Connected","isDefaultUsername":true}],"sandboxes":[{"alias":"myorg","username":"user@example.com.sandbox","orgId":"00D2","instanceUrl":"https://example--dev.sandbox.my.salesforce.com","connectedStatus":"Connected","isSandbox":true}],"scratchOrgs":[]}}' ;;
  *)
    echo '{"status":1,"name":"CommandNotFound","message":"comando non gestito dalla CLI finta"}'; exit 1 ;;
esac
`,
  "utf8",
);
chmodSync(fakeSf, 0o755);

// --- Mock dell'API REST Salesforce ----------------------------------------
const requests = [];
// La CLI finta dichiara API 67.0: il server deve seguire la org, non il fallback 61.0.
const V = "/services/data/v67.0";

const PAGE1 = {
  totalSize: 3,
  done: false,
  nextRecordsUrl: `${V}/query/01g000-2000`,
  records: [
    {
      attributes: { type: "Account", url: `${V}/sobjects/Account/001A` },
      Id: "001A",
      Name: "Acme, Inc",
      Owner: { attributes: { type: "User" }, Name: "Mario Rossi" },
    },
    { attributes: { type: "Account" }, Id: "001B", Name: "Beta Srl" },
  ],
};
const PAGE2 = {
  totalSize: 3,
  done: true,
  records: [{ attributes: { type: "Account" }, Id: "001C", Name: "Gamma SpA" }],
};
const ACCOUNT_DESCRIBE = {
  name: "Account",
  label: "Account",
  labelPlural: "Accounts",
  custom: false,
  queryable: true,
  createable: true,
  updateable: true,
  deletable: true,
  keyPrefix: "001",
  fields: [
    { name: "Id", label: "Account ID", type: "id", nillable: false, createable: false, updateable: false, unique: false, externalId: false, defaultedOnCreate: true, calculated: false },
    { name: "Name", label: "Account Name", type: "string", length: 255, nillable: false, createable: true, updateable: true, unique: false, externalId: false, defaultedOnCreate: false, calculated: false },
    { name: "AnnualRevenue", label: "Annual Revenue", type: "currency", precision: 18, scale: 2, nillable: true, createable: true, updateable: true, unique: false, externalId: false, defaultedOnCreate: false, calculated: false },
    { name: "OwnerId", label: "Owner ID", type: "reference", referenceTo: ["User"], relationshipName: "Owner", nillable: false, createable: true, updateable: true, unique: false, externalId: false, defaultedOnCreate: true, calculated: false },
    { name: "Industry", label: "Industry", type: "picklist", nillable: true, createable: true, updateable: true, unique: false, externalId: false, defaultedOnCreate: false, calculated: false,
      picklistValues: [
        { value: "Banking", label: "Banking", active: true, defaultValue: false },
        { value: "Retail", label: "Retail", active: true, defaultValue: false },
        { value: "Obsoleto", label: "Obsoleto", active: false, defaultValue: false },
      ] },
  ],
  childRelationships: [
    { childSObject: "Contact", field: "AccountId", relationshipName: "Contacts" },
    { childSObject: "Case", field: "AccountId", relationshipName: null },
  ],
  recordTypeInfos: [
    { name: "Master", recordTypeId: "012000", available: true, master: true },
    { name: "PMI", recordTypeId: "012001", available: true, master: false },
  ],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  requests.push({ path: url.pathname, token, batch: req.headers["sforce-query-options"] ?? null });

  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Il primo token restituito dalla CLI finta è scaduto: deve scattare il retry.
  if (token === "STALE") {
    return send(401, [{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]);
  }

  if (url.pathname === `${V}/query`) {
    const q = url.searchParams.get("q") ?? "";
    if (/FROM\s+Organization/i.test(q)) {
      return send(200, {
        totalSize: 1,
        done: true,
        records: [{ attributes: { type: "Organization" }, Id: "00D000000000001EAA", Name: "Dev Sandbox", IsSandbox: true, OrganizationType: "Enterprise Edition", InstanceName: "EU45", TrialExpirationDate: null }],
      });
    }
    if (/count\s*\(\s*\)/i.test(q)) {
      return send(200, { totalSize: 42, done: true, records: [] });
    }
    if (/FROM\s+Inesistente/i.test(q)) {
      return send(400, [{ message: "sObject type 'Inesistente' is not supported.", errorCode: "INVALID_TYPE" }]);
    }
    return send(200, PAGE1);
  }
  if (url.pathname === `${V}/tooling/query`) {
    const q = url.searchParams.get("q") ?? "";
    if (/FROM\s+Inesistente/i.test(q)) {
      return send(400, [{ message: "sObject type 'Inesistente' is not supported.", errorCode: "INVALID_TYPE" }]);
    }
    return send(200, {
      totalSize: 1,
      done: true,
      records: [{ attributes: { type: "EntityDefinition" }, QualifiedApiName: "Account", Label: "Account" }],
    });
  }
  if (url.pathname === `${V}/query/01g000-2000`) return send(200, PAGE2);
  if (url.pathname === `${V}/limits`) {
    return send(200, { DailyApiRequests: { Max: 1000, Remaining: 250 }, DataStorageMB: { Max: 100, Remaining: 100 } });
  }
  if (url.pathname === `${V}/sobjects`) {
    return send(200, {
      sobjects: [
        { name: "Account", label: "Account", custom: false, queryable: true, keyPrefix: "001", createable: true, updateable: true, deletable: true },
        { name: "Fattura__c", label: "Fattura", custom: true, queryable: true, keyPrefix: "a01", createable: true, updateable: true, deletable: true },
        { name: "OggettoInterno", label: "Interno", custom: false, queryable: false, keyPrefix: null, createable: false, updateable: false, deletable: false },
      ],
    });
  }
  if (url.pathname === `${V}/sobjects/Account/describe`) return send(200, ACCOUNT_DESCRIBE);
  return send(404, [{ message: `not found: ${url.pathname}`, errorCode: "NOT_FOUND" }]);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

process.env.ORGMCP_SF_PATH = fakeSf;
process.env.ORGMCP_EXPORT_DIR = join(work, "exports");
process.env.ORGMCP_DEFAULT_ORG = "myorg";
process.env.MOCK_PORT = String(port);
process.env.MOCK_COUNTER = counterFile;
process.env.MOCK_ARGS_LOG = argsLog;
writeFileSync(argsLog, "", "utf8");

const recorder = await registerAll(createRecorder());
const call = caller(recorder, { verbose: true });
const data = (res) => res.structuredContent;

section("Preflight con la CLI disponibile");
let res = await call("sf_preflight");
assert(!res.isError && data(res).sfCli.version === "2.99.0", "estrae la versione dall'output testuale di `sf --version`");
assert(data(res).sfCli.node === "v20.11.0", "estrae anche la versione di Node");
assert(data(res).config.defaultOrg === "myorg", "riporta l'alias di default configurato");
assert(/automatica/.test(data(res).config.apiVersion), "senza override, la versione API segue la org");

section("Query, retry sul token scaduto e paginazione");
res = await call("sf_soql", { query: "SELECT Id, Name FROM Account LIMIT 5", pageSize: 200, tooling: false });
assert(!res.isError, "la query riesce nonostante il primo token fosse scaduto");
assert(
  requests.filter((r) => r.token === "STALE").length === 1 && requests.some((r) => r.token === "FRESH"),
  "esattamente un retry dopo il 401, con token rinnovato",
);
assert(data(res).records[0]._sobject === "Account", "il tipo di oggetto è esposto come _sobject");
assert(data(res).records[0].attributes === undefined, "il blocco attributes non finisce nell'output");
assert(data(res).nextRecordsUrl === `${V}/query/01g000-2000`, "nextRecordsUrl viene propagato");
assert(/sf_soql_more/.test(data(res).hint), "l'output spiega come prendere la pagina successiva");
assert(
  requests.find((r) => r.path === `${V}/query` && r.token === "FRESH").batch === "batchSize=200",
  "la dimensione pagina viaggia nell'header Sforce-Query-Options",
);

res = await call("sf_soql_more", { nextRecordsUrl: `${V}/query/01g000-2000` });
assert(!res.isError && data(res).done === true, "la seconda pagina chiude il cursore");
assert(data(res).records[0].Id === "001C", "la seconda pagina contiene i record successivi");

res = await call("sf_soql", { query: "SELECT COUNT() FROM Account", pageSize: 200, tooling: false });
assert(data(res).count === 42, "SELECT COUNT() restituisce il conteggio invece di una lista vuota");
assert(data(res).message === undefined, "COUNT() non viene segnalato come 'nessun record'");

section("Cache dell'access token");
const before = Number(readFileSync(counterFile, "utf8").trim());
await call("sf_limits", { onlyUsed: false });
const after = Number(readFileSync(counterFile, "utf8").trim());
assert(before === after, "il token viene riusato dalla cache senza reinvocare la CLI");

section("Limiti della org");
res = await call("sf_limits", { onlyUsed: true });
assert(data(res).limits.length === 1, "i limiti non utilizzati vengono esclusi");
assert(data(res).limits[0].name === "DailyApiRequests" && data(res).limits[0].usedPct === 75, "usedPct calcolato correttamente");

section("Errori Salesforce tradotti in messaggi azionabili");
res = await call("sf_soql", { query: "SELECT Id FROM Inesistente LIMIT 1", pageSize: 200, tooling: false });
assert(res.isError && /INVALID_TYPE/.test(res.content[0].text), "il codice di errore Salesforce è riportato");
assert(/tooling: true/.test(res.content[0].text), "su INVALID_TYPE suggerisce la Tooling API per gli oggetti di setup");
assert(/permessi/i.test(res.content[0].text), "su INVALID_TYPE cita anche i permessi mancanti");
res = await call("sf_soql", { query: "SELECT Id FROM Inesistente", pageSize: 200, tooling: true });
assert(
  res.isError && /permessi di setup|View Setup/i.test(res.content[0].text),
  "in modalità tooling l'errore parla di permessi di setup, non di riprovare con tooling",
);

res = await call("sf_soql", {
  query: "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'Account'",
  pageSize: 200,
  tooling: true,
});
assert(!res.isError && res.structuredContent.records[0].QualifiedApiName === "Account", "la Tooling API restituisce i dati");
assert(requests.some((r) => r.path === `${V}/tooling/query`), "le query tooling usano l'endpoint /tooling/query");

section("Scoperta dello schema");
res = await call("sf_describe_global", { customOnly: true, queryableOnly: true, limit: 200 });
assert(data(res).sobjects.length === 1 && data(res).sobjects[0].name === "Fattura__c", "customOnly filtra gli oggetti custom");
res = await call("sf_describe_global", { nameContains: "account", customOnly: false, queryableOnly: true, limit: 200 });
assert(data(res).matched === 1 && data(res).totalInOrg === 3, "nameContains filtra e gli oggetti non interrogabili sono esclusi");

res = await call("sf_describe_object", { sobject: "Account", includePicklists: true, includeChildRelationships: true, fieldLimit: 300 });
const fields = Object.fromEntries(data(res).fields.map((f) => [f.name, f]));
assert(data(res).fieldCount === 5 && fields.Name.length === 255, "campi e lunghezza dei testi");
assert(fields.OwnerId.referenceTo[0] === "User" && fields.OwnerId.relationshipName === "Owner", "lookup con referenceTo e relationshipName");
assert(JSON.stringify(fields.Industry.picklistValues) === '["Banking","Retail"]', "solo i valori di picklist attivi");
assert(fields.AnnualRevenue.precision === 18 && fields.AnnualRevenue.scale === 2, "i campi currency riportano precision e scale");
assert(fields.Id.createable === false, "i campi non creabili sono segnalati");
assert(data(res).recordTypes[0] === "PMI", "i record type non-master sono elencati");
assert(data(res).childRelationships.length === 1, "solo le relazioni figlio con nome sono utilizzabili in SOQL");
res = await call("sf_describe_object", { sobject: "Account", fieldNameContains: "revenue", includePicklists: false, includeChildRelationships: false, fieldLimit: 300 });
assert(data(res).returnedFields === 1 && data(res).fields[0].name === "AnnualRevenue", "il filtro sui nomi dei campi funziona");

section("Export su file");
res = await call("sf_soql", { query: "SELECT Id, Name FROM Account", pageSize: 200, tooling: false, exportTo: "csv" });
assert(!res.isError && data(res).export.rowCount === 3, "l'export scorre tutte le pagine (3 record)");
assert(data(res).export.columns.includes("Owner.Name"), "le relazioni diventano colonne del CSV");
const csv = readFileSync(data(res).export.filePath, "utf8");
assert(csv.includes('"Acme, Inc"') && csv.trim().split("\n").length === 4, "il file CSV contiene header e 3 righe");

section("Org autorizzate e informazioni della org");
res = await call("sf_list_orgs", { checkConnection: false, connectedOnly: false });
assert(data(res).count === 2, "i gruppi restituiti dalla CLI vengono appiattiti");
assert(data(res).orgs.find((o) => o.alias === "myorg").type === "sandbox", "le sandbox sono riconosciute");
assert(data(res).connectionChecked === false, "di default la verifica di connessione è disattivata");
let cliArgs = readFileSync(argsLog, "utf8").split("\n").filter((l) => l.includes("org list"));
assert(
  cliArgs.at(-1).includes("--skip-connection-status"),
  "`sf org list` usa --skip-connection-status per non impiegare decine di secondi",
);
res = await call("sf_list_orgs", { checkConnection: true, connectedOnly: false });
cliArgs = readFileSync(argsLog, "utf8").split("\n").filter((l) => l.includes("org list"));
assert(
  !cliArgs.at(-1).includes("--skip-connection-status") && data(res).connectionChecked === true,
  "con checkConnection la verifica viene richiesta esplicitamente",
);

res = await call("sf_org_info", { includeLimits: true });
const serialized = JSON.stringify(data(res));
assert(!serialized.includes("FRESH") && !serialized.includes("accessToken"), "nessun access token compare nell'output");
assert(data(res).isSandbox === true && data(res).organizationType === "Enterprise Edition", "sandbox e tipo di org letti dall'oggetto Organization");
assert(data(res).limits.DailyApiRequests.usedPct === 75, "i limiti principali sono inclusi su richiesta");
assert(data(res).apiVersion === "67.0", "l'org dichiara API 67.0");
assert(
  requests.every((r) => !r.path.includes("/v61.0/")) && requests.some((r) => r.path.includes("/v67.0/")),
  "tutte le chiamate usano la versione API della org, non il fallback compilato",
);

server.close();
summary("e2e");
