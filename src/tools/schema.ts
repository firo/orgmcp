import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DESCRIBE_GLOBAL_LIMIT, PICKLIST_INLINE_LIMIT } from "../constants.js";
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS } from "../result.js";
import { describeGlobal, describeObject, type FieldDescribe } from "../salesforce.js";

/** Riduce il describe di un campo all'essenziale per un agente. */
function compactField(field: FieldDescribe, includePicklists: boolean) {
  const out: Record<string, unknown> = {
    name: field.name,
    label: field.label,
    type: field.type,
    nillable: field.nillable,
  };

  if (field.length && ["string", "textarea", "email", "phone", "url", "picklist"].includes(field.type)) {
    out.length = field.length;
  }
  if (["double", "currency", "percent", "int"].includes(field.type)) {
    out.precision = field.precision;
    out.scale = field.scale;
  }
  if (field.referenceTo?.length) {
    out.referenceTo = field.referenceTo;
    if (field.relationshipName) out.relationshipName = field.relationshipName;
  }
  if (field.unique) out.unique = true;
  if (field.externalId) out.externalId = true;
  if (field.calculated) out.calculated = true;
  if (!field.createable) out.createable = false;
  if (!field.updateable) out.updateable = false;
  if (field.inlineHelpText) out.helpText = field.inlineHelpText;

  const picklist = field.picklistValues ?? [];
  if (picklist.length > 0) {
    const active = picklist.filter((p) => p.active);
    if (includePicklists && active.length <= PICKLIST_INLINE_LIMIT) {
      out.picklistValues = active.map((p) => p.value);
    } else {
      out.picklistValueCount = active.length;
      out.picklistHint = includePicklists
        ? `Troppi valori (${active.length}) per l'output inline: interroga PicklistValueInfo o il campo nel Setup.`
        : "Imposta `includePicklists: true` per vedere i valori.";
    }
  }

  return out;
}

export function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    "sf_describe_global",
    {
      title: "Elenca gli sObject della org",
      description: `Elenca gli sObject disponibili nella org (standard e custom), in forma compatta.

La org può avere centinaia di oggetti: usa sempre \`nameContains\` o \`customOnly\` per restringere.

Args:
  - org (string, opzionale): alias dell'org.
  - nameContains (string, opzionale): filtra per sottostringa su nome API o etichetta (case-insensitive), es. "invoice".
  - customOnly (boolean, default false): solo oggetti custom (__c).
  - queryableOnly (boolean, default true): esclude gli oggetti non interrogabili via SOQL.
  - limit (number 1-500, default ${DESCRIBE_GLOBAL_LIMIT}): numero massimo di oggetti restituiti.

Returns:
{ "org": string, "totalInOrg": number, "matched": number, "returned": number, "sobjects": [ { "name": string, "label": string, "custom": boolean, "queryable": boolean, "keyPrefix": string|null } ] }

Usalo quando: non conosci il nome API di un oggetto. Per i campi di un oggetto specifico usa \`sf_describe_object\`.`,
      inputSchema: {
        org: z.string().min(1).optional().describe("Alias dell'org"),
        nameContains: z
          .string()
          .min(1)
          .optional()
          .describe("Filtro su nome API o etichetta, es. 'account'"),
        customOnly: z.boolean().default(false).describe("Solo oggetti custom (__c)"),
        queryableOnly: z.boolean().default(true).describe("Solo oggetti interrogabili via SOQL"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(DESCRIBE_GLOBAL_LIMIT)
          .describe("Numero massimo di oggetti restituiti"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ org, nameContains, customOnly, queryableOnly, limit }) => {
      try {
        const { data, auth } = await describeGlobal(org);
        const all = data.sobjects ?? [];
        const needle = nameContains?.toLowerCase();

        const matched = all
          .filter((s) => (customOnly ? s.custom : true))
          .filter((s) => (queryableOnly ? s.queryable : true))
          .filter((s) =>
            needle
              ? s.name.toLowerCase().includes(needle) ||
                (s.label ?? "").toLowerCase().includes(needle)
              : true,
          )
          .sort((a, b) => a.name.localeCompare(b.name));

        const sobjects = matched.slice(0, limit).map((s) => ({
          name: s.name,
          label: s.label,
          custom: s.custom,
          queryable: s.queryable,
          keyPrefix: s.keyPrefix ?? null,
        }));

        return jsonResult({
          org: auth.alias,
          totalInOrg: all.length,
          matched: matched.length,
          returned: sobjects.length,
          sobjects,
          ...(matched.length > sobjects.length
            ? {
                hint: `Mostrati ${sobjects.length} di ${matched.length} oggetti: restringi con \`nameContains\` o alza \`limit\`.`,
              }
            : {}),
          ...(matched.length === 0
            ? { message: "Nessun oggetto corrisponde ai filtri indicati." }
            : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_describe_object",
    {
      title: "Descrivi un sObject",
      description: `Restituisce i metadati di un sObject: campi con nome API, tipo, obbligatorietà, relazioni e picklist.

È il tool da usare prima di scrivere una SOQL, per conoscere i nomi API corretti dei campi.

Args:
  - sobject (string): nome API dell'oggetto, es. "Account", "Opportunity", "My_Object__c".
  - org (string, opzionale): alias dell'org.
  - fieldNameContains (string, opzionale): mostra solo i campi il cui nome o etichetta contiene questa stringa.
  - includePicklists (boolean, default false): include i valori delle picklist (solo se meno di ${PICKLIST_INLINE_LIMIT}).
  - includeChildRelationships (boolean, default false): include le relazioni figlio (per le sub-query SOQL).
  - fieldLimit (number 1-1000, default 300): numero massimo di campi restituiti.

Returns:
{
  "org": string,
  "object": { "name": string, "label": string, "custom": boolean, "queryable": boolean, "createable": boolean, "updateable": boolean, "deletable": boolean, "keyPrefix": string|null },
  "fieldCount": number,
  "returnedFields": number,
  "fields": [ { "name": string, "label": string, "type": string, "nillable": boolean, "referenceTo"?: string[], "relationshipName"?: string, "picklistValues"?: string[] } ],
  "recordTypes"?: string[],
  "childRelationships"?: [ { "childSObject": string, "field": string, "relationshipName": string|null } ]
}

Esempi:
  - "Quali campi ha Account?" → sobject "Account"
  - "Come si chiama il campo importo dell'opportunity?" → sobject "Opportunity", fieldNameContains "amount"
  - "Quali valori ha lo stage?" → sobject "Opportunity", fieldNameContains "stage", includePicklists true

Errori: NOT_FOUND se l'oggetto non esiste o l'utente non ha accesso — verifica il nome con \`sf_describe_global\`.`,
      inputSchema: {
        sobject: z
          .string()
          .min(1)
          .max(80)
          .describe("Nome API dell'oggetto, es. 'Account' o 'Fattura__c'"),
        org: z.string().min(1).optional().describe("Alias dell'org"),
        fieldNameContains: z
          .string()
          .min(1)
          .optional()
          .describe("Filtro sui campi, es. 'amount' o 'data'"),
        includePicklists: z
          .boolean()
          .default(false)
          .describe("Include i valori delle picklist attive"),
        includeChildRelationships: z
          .boolean()
          .default(false)
          .describe("Include le relazioni figlio, utili per le sub-query SOQL"),
        fieldLimit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(300)
          .describe("Numero massimo di campi restituiti"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      sobject,
      org,
      fieldNameContains,
      includePicklists,
      includeChildRelationships,
      fieldLimit,
    }) => {
      try {
        const { data, auth } = await describeObject(org, sobject);
        const needle = fieldNameContains?.toLowerCase();

        const allFields = data.fields ?? [];
        const matched = needle
          ? allFields.filter(
              (f) =>
                f.name.toLowerCase().includes(needle) ||
                (f.label ?? "").toLowerCase().includes(needle),
            )
          : allFields;

        const fields = matched
          .slice(0, fieldLimit)
          .map((f) => compactField(f, includePicklists));

        const payload: Record<string, unknown> = {
          org: auth.alias,
          object: {
            name: data.name,
            label: data.label,
            custom: data.custom,
            queryable: data.queryable,
            createable: data.createable,
            updateable: data.updateable,
            deletable: data.deletable,
            keyPrefix: data.keyPrefix ?? null,
          },
          fieldCount: allFields.length,
          matchedFields: matched.length,
          returnedFields: fields.length,
          fields,
        };

        if (matched.length > fields.length) {
          payload.hint = `Mostrati ${fields.length} di ${matched.length} campi: restringi con \`fieldNameContains\` o alza \`fieldLimit\`.`;
        }
        if (needle && matched.length === 0) {
          payload.message = `Nessun campo di ${data.name} contiene "${fieldNameContains}".`;
        }

        const recordTypes = (data.recordTypeInfos ?? []).filter((rt) => !rt.master);
        if (recordTypes.length > 0) {
          payload.recordTypes = recordTypes.map((rt) => rt.name);
        }
        if (includeChildRelationships) {
          payload.childRelationships = (data.childRelationships ?? [])
            .filter((c) => c.relationshipName)
            .map((c) => ({
              childSObject: c.childSObject,
              field: c.field,
              relationshipName: c.relationshipName,
            }));
        }

        return jsonResult(payload);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
