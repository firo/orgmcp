import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "../config.js";
import { ActionableError } from "../errors.js";
import { writeExport } from "../export.js";
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS } from "../result.js";
import {
  runQuery,
  runQueryAll,
  runQueryMore,
  type QueryResult,
  type SalesforceRecord,
} from "../salesforce.js";

/** Rimuove `attributes` dal primo livello, così l'output resta leggibile. */
function stripAttributes(records: SalesforceRecord[]): Record<string, unknown>[] {
  return records.map((record) => {
    const { attributes, ...rest } = record;
    const type = attributes?.type;
    return type ? { _sobject: type, ...rest } : rest;
  });
}

/** Blocca tutto ciò che non è una lettura: la v0.1 è read-only per contratto. */
function assertReadOnlyQuery(query: string): string {
  const trimmed = query.trim().replace(/;+$/, "");
  if (!trimmed) {
    throw new ActionableError("La query è vuota.", "Fornisci una SOQL, es. `SELECT Id, Name FROM Account LIMIT 10`.");
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new ActionableError(
      "Sono ammesse solo query SOQL di lettura (SELECT).",
      "Questo server è read-only: insert, update, delete e Apex anonimo non sono disponibili in questa versione.",
    );
  }
  if (/^select\s+\*/i.test(trimmed)) {
    throw new ActionableError(
      "SOQL non supporta `SELECT *`.",
      "Elenca i campi esplicitamente; usa `sf_describe_object` per scoprire i nomi API dei campi.",
    );
  }
  return trimmed;
}

function paginationInfo(result: QueryResult, returned: number) {
  return {
    totalSize: result.totalSize,
    returned,
    done: result.done,
    ...(result.nextRecordsUrl
      ? {
          nextRecordsUrl: result.nextRecordsUrl,
          hint: "Ci sono altri record: richiama `sf_soql_more` passando questo `nextRecordsUrl`.",
        }
      : {}),
  };
}

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    "sf_soql",
    {
      title: "Esegui una query SOQL",
      description: `Esegue una query SOQL di sola lettura su una org Salesforce e restituisce i record.

Solo SELECT: insert/update/delete non sono supportati in questa versione.

Args:
  - query (string): la SOQL, es. "SELECT Id, Name, Owner.Name FROM Account WHERE CreatedDate = LAST_N_DAYS:30 ORDER BY Name LIMIT 50".
  - org (string, opzionale): alias dell'org (default: alias configurato).
  - pageSize (number 200-2000, default ${config.pageSizeDefault}): dimensione della pagina restituita. Per ottenere MENO record usa LIMIT nella query, non pageSize.
  - tooling (boolean, default false): usa la Tooling API invece della Data API (necessario per ApexClass, Flow, FieldDefinition, EntityDefinition e altri oggetti di setup).
  - exportTo ('csv' | 'json', opzionale): scarica TUTTE le pagine e le scrive su file in ${config.exportDir}, restituendo path, conteggio e le prime 10 righe di anteprima. Usalo per estrazioni grandi invece di paginare a mano.

Returns (senza exportTo):
{ "org": string, "totalSize": number, "returned": number, "done": boolean, "nextRecordsUrl"?: string, "records": [ { "_sobject": string, ...campi } ] }

Returns (con exportTo):
{ "org": string, "totalSize": number, "export": { "filePath": string, "format": "csv"|"json", "rowCount": number, "columns": string[], "preview": object[] }, "truncated": boolean }

Esempi:
  - "Quanti account ci sono?" → query "SELECT COUNT() FROM Account"
  - "Le 10 opportunity più grandi aperte" → "SELECT Id, Name, Amount, StageName FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC LIMIT 10"
  - "Elenca le Apex class" → query "SELECT Id, Name, ApiVersion FROM ApexClass ORDER BY Name" con tooling = true

Errori frequenti:
  - INVALID_FIELD / INVALID_TYPE → nome API sbagliato: verifica con \`sf_describe_object\`.
  - MALFORMED_QUERY → sintassi SOQL non valida.
  - Se restituisce "org non autorizzata" o INVALID_SESSION_ID → usa \`sf_login\`.`,
      inputSchema: {
        query: z
          .string()
          .min(10, "La query è troppo corta per essere una SOQL valida")
          .max(20_000)
          .describe("Query SOQL (solo SELECT)"),
        org: z.string().min(1).optional().describe("Alias dell'org, es. 'myorg'"),
        pageSize: z
          .number()
          .int()
          .min(200)
          .max(2000)
          .default(config.pageSizeDefault)
          .describe("Dimensione pagina (200-2000). Per meno record usa LIMIT nella query"),
        tooling: z
          .boolean()
          .default(false)
          .describe("Usa la Tooling API (oggetti di setup come ApexClass, Flow, FieldDefinition)"),
        exportTo: z
          .enum(["csv", "json"])
          .optional()
          .describe("Scarica tutte le pagine su file invece di restituire i record inline"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, org, pageSize, tooling, exportTo }) => {
      try {
        const soql = assertReadOnlyQuery(query);

        if (exportTo) {
          const { records, totalSize, truncated, auth } = await runQueryAll(org, soql, {
            tooling,
          });
          if (records.length === 0) {
            return jsonResult({
              org: auth.alias,
              totalSize,
              exported: false,
              message: "La query non ha restituito record: nessun file creato.",
            });
          }
          const objectName = /from\s+([A-Za-z0-9_]+)/i.exec(soql)?.[1] ?? "query";
          const exported = writeExport(records, exportTo, objectName);
          return jsonResult({
            org: auth.alias,
            totalSize,
            truncated,
            ...(truncated
              ? {
                  truncationMessage: `Export limitato a ${config.maxExportRecords} record (tetto \`maxExportRecords\`).`,
                }
              : {}),
            export: exported,
          });
        }

        const { result, auth } = await runQuery(org, soql, { pageSize, tooling });
        const records = stripAttributes(result.records ?? []);

        // `SELECT COUNT()` non restituisce record: il risultato è in totalSize.
        if (/^select\s+count\s*\(\s*\)/i.test(soql)) {
          return jsonResult({ org: auth.alias, count: result.totalSize, records: [] });
        }

        return jsonResult({
          org: auth.alias,
          ...paginationInfo(result, records.length),
          records,
          ...(records.length === 0
            ? { message: "Nessun record corrisponde alla query." }
            : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_soql_more",
    {
      title: "Pagina successiva di una query SOQL",
      description: `Recupera la pagina successiva dei risultati di una query SOQL, usando il \`nextRecordsUrl\` restituito da \`sf_soql\` o da una chiamata precedente a questo tool.

Args:
  - nextRecordsUrl (string): il valore esatto di \`nextRecordsUrl\`, es. "/services/data/v61.0/query/01g...-2000".
  - org (string, opzionale): alias dell'org; deve essere la stessa org della query iniziale.

Returns:
{ "org": string, "totalSize": number, "returned": number, "done": boolean, "nextRecordsUrl"?: string, "records": object[] }

Nota: il cursore di una query scade dopo circa 15 minuti. Se restituisce un errore di cursore non valido, rieseguire \`sf_soql\`.`,
      inputSchema: {
        nextRecordsUrl: z
          .string()
          .min(10)
          .describe("Il nextRecordsUrl restituito dalla chiamata precedente"),
        org: z.string().min(1).optional().describe("Alias dell'org"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ nextRecordsUrl, org }) => {
      try {
        if (!nextRecordsUrl.startsWith("/services/data/")) {
          return errorResult(
            new ActionableError(
              `\`nextRecordsUrl\` non valido: "${nextRecordsUrl}".`,
              "Deve essere il path restituito da `sf_soql`, che inizia con /services/data/.",
            ),
          );
        }
        const { result, auth } = await runQueryMore(org, nextRecordsUrl);
        const records = stripAttributes(result.records ?? []);
        return jsonResult({
          org: auth.alias,
          ...paginationInfo(result, records.length),
          records,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
