/** Test delle funzioni pure: appiattimento record, CSV, export, troncamento output. */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ORGMCP_EXPORT_DIR = join(tmpdir(), "orgmcp-test-exports");

import { assert, DIST, section, summary } from "./helpers.mjs";

const { flattenRecord, toCsv, collectColumns, writeExport } = await import(`${DIST}/export.js`);
const { jsonResult, errorResult } = await import(`${DIST}/result.js`);
const { config } = await import(`${DIST}/config.js`);
const { ActionableError } = await import(`${DIST}/errors.js`);

const record = {
  attributes: { type: "Account", url: "/services/data/v61.0/sobjects/Account/001A" },
  Id: "001A",
  Name: 'Acme, "Inc"',
  Owner: { attributes: { type: "User" }, Name: "Mario Rossi", Profile: { Name: "System Admin" } },
  AnnualRevenue: null,
  Contacts: {
    totalSize: 1,
    done: true,
    records: [{ attributes: { type: "Contact" }, Id: "003A", LastName: "Bianchi" }],
  },
};

section("Appiattimento dei record");
const flat = flattenRecord(record);
assert(!("attributes" in flat), "il blocco attributes viene rimosso");
assert(flat["Owner.Name"] === "Mario Rossi", "le relazioni diventano dot-notation");
assert(flat["Owner.Profile.Name"] === "System Admin", "le relazioni annidate su 2 livelli funzionano");
assert(flat.AnnualRevenue === "", "i null diventano stringa vuota");
assert(JSON.parse(flat.Contacts)[0].LastName === "Bianchi", "le sub-query vengono serializzate in JSON");

section("Generazione CSV");
const columns = collectColumns([flat]);
const csv = toCsv([flat], columns);
assert(csv.includes('"Acme, ""Inc"""'), "virgole e virgolette vengono escapate");
assert(csv.trim().split("\n").length === 2, "una riga di header più una di dati");

section("Export su file");
const exported = writeExport([record, record], "csv", "Account");
assert(exported.rowCount === 2, "il CSV contiene entrambi i record");
assert(exported.filePath.startsWith(config.exportDir), `il file finisce in exportDir (${config.exportDir})`);
assert(readFileSync(exported.filePath, "utf8").includes("Owner.Name"), "l'header contiene le colonne relazione");
const exportedJson = writeExport([record], "json", "Account");
assert(exportedJson.format === "json" && exportedJson.preview.length === 1, "l'export JSON include l'anteprima");

section("Protezione del contesto");
const big = {
  org: "myorg",
  totalSize: 5000,
  records: Array.from({ length: 5000 }, (_, i) => ({
    Id: `001${i}`,
    Name: `Account numero ${i}`,
    Descrizione: "x".repeat(40),
  })),
};
const truncatedResult = jsonResult(big);
assert(truncatedResult.content[0].text.length <= 25_000, "l'output resta sotto i 25.000 caratteri");
assert(truncatedResult.structuredContent.truncated === true, "il flag truncated viene impostato");
assert(
  truncatedResult.structuredContent.records.length < 5000,
  `i record vengono ridotti (${truncatedResult.structuredContent.records.length} su 5000)`,
);
assert(
  /exportTo/.test(truncatedResult.structuredContent.truncationMessage),
  "il messaggio di troncamento suggerisce l'export su file",
);
const small = jsonResult({ org: "myorg", records: [{ Id: "001A" }] });
assert(small.structuredContent.truncated === undefined, "un payload piccolo non viene toccato");

section("Errori azionabili");
const err = errorResult(new ActionableError("Org non autorizzata.", "Usa il tool sf_login."));
assert(err.isError === true, "il risultato è marcato come errore");
assert(err.content[0].text.includes("Cosa fare: Usa il tool sf_login."), "l'errore contiene il passo successivo");

summary("unit");
