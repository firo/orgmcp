/** Test di registrazione dei tool e dei guardrail che non richiedono rete. */
import { assert, caller, createRecorder, registerAll, section, summary } from "./helpers.mjs";

// Percorso CLI inesistente: deve produrre un errore chiaro anche su macchine
// dove `sf` è regolarmente installata nel PATH (nessun fallback silenzioso).
const FAKE_PATH = "/percorso/che/non/esiste/sf";
process.env.ORGMCP_SF_PATH = FAKE_PATH;

const recorder = await registerAll(createRecorder());
const call = caller(recorder);

const EXPECTED = [
  "sf_preflight",
  "sf_login",
  "sf_list_orgs",
  "sf_org_info",
  "sf_limits",
  "sf_soql",
  "sf_soql_more",
  "sf_describe_global",
  "sf_describe_object",
];

section("Registrazione dei tool");
assert(recorder.tools.size === EXPECTED.length, `${EXPECTED.length} tool registrati`);
for (const name of EXPECTED) {
  assert(recorder.tools.has(name), `tool presente: ${name}`);
}
for (const [name, tool] of recorder.tools) {
  assert(typeof tool.cfg.title === "string" && tool.cfg.title.length > 0, `${name}: title presente`);
  assert(
    typeof tool.cfg.description === "string" && tool.cfg.description.includes("Returns"),
    `${name}: description documenta l'output`,
  );
  assert(
    tool.cfg.annotations && typeof tool.cfg.annotations.readOnlyHint === "boolean",
    `${name}: annotations presenti`,
  );
}
assert(recorder.tools.get("sf_soql").cfg.annotations.readOnlyHint === true, "sf_soql è annotato read-only");
assert(
  recorder.tools.get("sf_login").cfg.annotations.readOnlyHint === false,
  "sf_login non è annotato read-only (apre il browser)",
);

section("Guardrail read-only sulle query");
for (const query of [
  "UPDATE Account SET Name = 'x' WHERE Id = '001'",
  "delete from Account where Id = '001'",
  "insert into Account (Name) values ('x')",
  "DROP TABLE Account",
]) {
  const res = await call("sf_soql", { query, pageSize: 200, tooling: false });
  assert(
    res.isError && /solo query SOQL di lettura/i.test(res.content[0].text),
    `query non-SELECT rifiutata: ${query.slice(0, 24)}…`,
  );
}
const star = await call("sf_soql", { query: "SELECT * FROM Account", pageSize: 200, tooling: false });
assert(star.isError && /SELECT \*/.test(star.content[0].text), "SELECT * rifiutata con spiegazione");
assert(/sf_describe_object/.test(star.content[0].text), "il rifiuto di SELECT * indirizza a sf_describe_object");

section("Validazione degli input");
const badUrl = await call("sf_soql_more", { nextRecordsUrl: "https://esterno.example.com/dati" });
assert(
  badUrl.isError && /non valido/.test(badUrl.content[0].text),
  "un nextRecordsUrl fuori da /services/data/ viene rifiutato",
);
const badTarget = await call("sf_login", { alias: "test", target: "qualcosa", setDefault: false });
assert(badTarget.isError && /non valido/.test(badTarget.content[0].text), "target di login non valido rifiutato");
const badObject = await call("sf_describe_object", {
  sobject: "Account'; DROP--",
  includePicklists: false,
  includeChildRelationships: false,
  fieldLimit: 300,
});
assert(
  badObject.isError && /non valido/.test(badObject.content[0].text),
  "nome sObject non valido rifiutato prima della chiamata di rete",
);

section("Salesforce CLI non raggiungibile");
const preflight = await call("sf_preflight");
assert(preflight.isError, "con sfCliPath errato il preflight fallisce");
assert(
  preflight.content[0].text.includes(FAKE_PATH),
  "l'errore riporta il percorso configurato, invece di ripiegare su un'altra sf del PATH",
);
assert(
  /sfCliPath/.test(preflight.content[0].text) && /which sf/.test(preflight.content[0].text),
  "l'errore dice come correggere la configurazione",
);
const soql = await call("sf_soql", { query: "SELECT Id FROM Account LIMIT 1", pageSize: 200, tooling: false });
assert(soql.isError && /sfCliPath/.test(soql.content[0].text), "anche sf_soql spiega il problema di configurazione");

summary("tools");
