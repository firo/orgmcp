import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config, configPath } from "../config.js";
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS } from "../result.js";
import { getLimits, getOrgProfile } from "../salesforce.js";
import { getOrgAuth, getSfVersion, publicAuthInfo, resolveSfBinary, runSf } from "../sf.js";

/** Campi della org restituiti dall'oggetto Organization, se accessibile. */
function orgProfileFields(profile: Awaited<ReturnType<typeof getOrgProfile>>["profile"]) {
  if (!profile) {
    return {
      orgName: null,
      isSandbox: null,
      organizationType: null,
      instanceName: null,
      profileNote:
        "Oggetto Organization non leggibile con questo utente: tipo di org e flag sandbox non determinabili.",
    };
  }
  return {
    orgName: profile.Name,
    isSandbox: profile.IsSandbox,
    organizationType: profile.OrganizationType,
    instanceName: profile.InstanceName,
  };
}

interface OrgListEntry {
  alias?: string;
  username?: string;
  orgId?: string;
  instanceUrl?: string;
  connectedStatus?: string;
  isSandbox?: boolean;
  isScratch?: boolean;
  isDevHub?: boolean;
  isDefaultUsername?: boolean;
  expirationDate?: string;
  status?: string;
}

/** `sf org list --json` raggruppa le org in più array: li appiattiamo. */
function flattenOrgList(result: unknown): OrgListEntry[] {
  if (!result || typeof result !== "object") return [];
  const out: OrgListEntry[] = [];
  const seen = new Set<string>();

  for (const [group, value] of Object.entries(result as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = item as OrgListEntry;
      const key = `${entry.username ?? ""}|${entry.orgId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...entry, ...(group ? { group } : {}) } as OrgListEntry);
    }
  }
  return out;
}

function compactOrg(entry: OrgListEntry & { group?: string }) {
  return {
    alias: entry.alias ?? null,
    username: entry.username ?? null,
    orgId: entry.orgId ?? null,
    instanceUrl: entry.instanceUrl ?? null,
    type: entry.isScratch ? "scratch" : entry.isSandbox ? "sandbox" : "production/other",
    connectedStatus: entry.connectedStatus ?? entry.status ?? null,
    isDefault: entry.isDefaultUsername ?? false,
    expirationDate: entry.expirationDate ?? null,
  };
}

export function registerOrgTools(server: McpServer): void {
  server.registerTool(
    "sf_preflight",
    {
      title: "Verifica prerequisiti",
      description: `Verifica che la Salesforce CLI (\`sf\`) sia installata e raggiungibile, e mostra la configurazione attiva del server.

Usalo come primo passo quando qualcosa non funziona, o per scoprire quale alias di org è usato per default.

Args: nessuno.

Returns:
{
  "sfCli": { "available": boolean, "binary": string, "version": string },
  "config": { "defaultOrg": string|null, "apiVersion": string, "pageSizeDefault": number, "exportDir": string, "configPath": string }
}

Errori: se \`sf\` non è installata, il messaggio contiene il comando di installazione.`,
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const binary = await resolveSfBinary();
        const version = await getSfVersion();
        return jsonResult({
          sfCli: {
            available: true,
            binary,
            version: version.cli ?? "sconosciuta",
            node: version.node,
            raw: version.raw,
          },
          config: {
            defaultOrg: config.defaultOrg ?? null,
            apiVersion: config.apiVersion ?? "automatica (quella dichiarata dalla org)",
            pageSizeDefault: config.pageSizeDefault,
            exportDir: config.exportDir,
            configPath,
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_login",
    {
      title: "Login a una org via browser",
      description: `Avvia il login OAuth via browser verso una org Salesforce e la memorizza con un alias.

Apre il browser di sistema sulla pagina di login Salesforce: l'utente inserisce le credenziali e concede il consenso. Il refresh token viene salvato dalla Salesforce CLI; questo server non vede né conserva password.
Non serve creare alcuna Connected App.

Il comando resta in attesa fino al completamento del login (timeout 5 minuti). Se il client MCP interrompe prima la chiamata, il login nel browser può comunque essere andato a buon fine: verificalo con \`sf_org_info\` sullo stesso alias invece di ripetere il login.

Args:
  - alias (string, opzionale): alias con cui salvare l'org (default: alias configurato).
  - target ('production' | 'sandbox' | string, default 'production'): 'production' → login.salesforce.com, 'sandbox' → test.salesforce.com, oppure un My Domain completo (es. https://azienda.my.salesforce.com).
  - setDefault (boolean, default false): imposta l'org come default della CLI.

Returns:
{ "loggedIn": true, "alias": string, "username": string, "orgId": string, "instanceUrl": string, "orgName": string|null, "isSandbox": boolean|null, "organizationType": string|null }

Usalo quando: sf_soql o sf_org_info restituiscono "org non autorizzata" o "sessione non valida".`,
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[A-Za-z0-9_.-]+$/, "Alias ammessi: lettere, numeri, punto, trattino, underscore")
          .optional()
          .describe("Alias con cui salvare l'org, es. 'myorg'"),
        target: z
          .string()
          .default("production")
          .describe("'production', 'sandbox' oppure un My Domain https://..."),
        setDefault: z
          .boolean()
          .default(false)
          .describe("Imposta questa org come default della Salesforce CLI"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ alias, target, setDefault }) => {
      try {
        const effectiveAlias = alias ?? config.defaultOrg;
        if (!effectiveAlias) {
          return errorResult(
            new Error(
              "Nessun alias indicato e nessun `defaultOrg` configurato. Passa il parametro `alias`.",
            ),
          );
        }

        let instanceUrl: string;
        const normalized = target.trim().toLowerCase();
        if (normalized === "production" || normalized === "prod") {
          instanceUrl = "https://login.salesforce.com";
        } else if (normalized === "sandbox" || normalized === "test") {
          instanceUrl = "https://test.salesforce.com";
        } else if (/^https?:\/\//.test(target.trim())) {
          instanceUrl = target.trim().replace(/\/+$/, "");
        } else {
          return errorResult(
            new Error(
              `Valore di \`target\` non valido: "${target}". Usa 'production', 'sandbox' oppure un URL completo https://...`,
            ),
          );
        }

        const args = [
          "org",
          "login",
          "web",
          "--alias",
          effectiveAlias,
          "--instance-url",
          instanceUrl,
        ];
        if (setDefault) args.push("--set-default");

        await runSf<{ orgId?: string; username?: string; instanceUrl?: string }>(args, {
          timeoutMs: 300_000,
        });

        const auth = await getOrgAuth(effectiveAlias, true);
        const { profile } = await getOrgProfile(effectiveAlias);
        return jsonResult({
          loggedIn: true,
          ...publicAuthInfo(auth),
          ...orgProfileFields(profile),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_list_orgs",
    {
      title: "Elenca le org autorizzate",
      description: `Elenca le org Salesforce già autorizzate su questa macchina (dallo store della Salesforce CLI).

Di default non verifica la connessione di ogni org, perché richiede una chiamata di rete per org e può impiegare decine di secondi: \`connectedStatus\` vale null e la risposta arriva in meno di un secondo.

Args:
  - checkConnection (boolean, default false): verifica la sessione di ogni org. Lento (secondi per org), ma valorizza connectedStatus.
  - connectedOnly (boolean, default false): mostra solo le org con sessione valida; implica checkConnection.

Returns:
{
  "count": number,
  "defaultOrgFromConfig": string|null,
  "connectionChecked": boolean,
  "orgs": [ { "alias": string|null, "username": string|null, "orgId": string|null, "instanceUrl": string|null, "type": "sandbox"|"scratch"|"production/other", "connectedStatus": string|null, "isDefault": boolean, "expirationDate": string|null } ]
}

Usalo quando: devi capire quali alias sono disponibili prima di lanciare una query. Se l'elenco è vuoto, usa \`sf_login\`.`,
      inputSchema: {
        checkConnection: z
          .boolean()
          .default(false)
          .describe("Verifica la sessione di ogni org (lento: una chiamata di rete per org)"),
        connectedOnly: z
          .boolean()
          .default(false)
          .describe("Solo org con sessione valida; forza la verifica della connessione"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ checkConnection, connectedOnly }) => {
      try {
        const verify = checkConnection || connectedOnly;
        const args = ["org", "list"];
        if (!verify) args.push("--skip-connection-status");

        const result = await runSf<unknown>(args, {
          tolerateFailure: true,
          // Con la verifica attiva la CLI contatta ogni org: serve molto più tempo.
          ...(verify ? { timeoutMs: 180_000 } : {}),
        });
        let orgs = flattenOrgList(result).map(compactOrg);
        if (connectedOnly) {
          orgs = orgs.filter((o) => /connected/i.test(o.connectedStatus ?? ""));
        }
        return jsonResult({
          count: orgs.length,
          defaultOrgFromConfig: config.defaultOrg ?? null,
          connectionChecked: verify,
          orgs,
          ...(orgs.length === 0
            ? { hint: "Nessuna org autorizzata: usa il tool `sf_login` per autenticarti via browser." }
            : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_org_info",
    {
      title: "Informazioni sulla org",
      description: `Restituisce le informazioni di una org: username, orgId, instance URL, versione API, nome della org, tipo (Enterprise, Developer Edition, ecc.) e se è una sandbox. Nessun token viene mai restituito.

Il flag sandbox e il tipo di org sono letti dall'oggetto Organization; valgono null se l'utente non ha accesso a quell'oggetto.

Args:
  - org (string, opzionale): alias dell'org (default: alias configurato).
  - includeLimits (boolean, default false): aggiunge i 5 limiti più significativi (API calls, storage, ecc.).

Returns:
{ "alias": string, "username": string, "orgId": string, "instanceUrl": string, "apiVersion": string, "orgName": string|null, "isSandbox": boolean|null, "organizationType": string|null, "instanceName": string|null, "limits"?: { "<nome>": { "max": number, "remaining": number, "usedPct": number } } }

Usalo quando: vuoi confermare su quale org stai lavorando prima di eseguire query.`,
      inputSchema: {
        org: z.string().min(1).optional().describe("Alias dell'org, es. 'myorg'"),
        includeLimits: z.boolean().default(false).describe("Includi i limiti principali della org"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ org, includeLimits }) => {
      try {
        const { profile, auth } = await getOrgProfile(org);
        const payload: Record<string, unknown> = {
          ...publicAuthInfo(auth),
          ...orgProfileFields(profile),
        };

        if (includeLimits) {
          const { data } = await getLimits(org);
          const interesting = [
            "DailyApiRequests",
            "DataStorageMB",
            "FileStorageMB",
            "DailyBulkApiBatches",
            "DailyAsyncApexExecutions",
          ];
          const limits: Record<string, unknown> = {};
          for (const key of interesting) {
            const entry = data[key];
            if (!entry) continue;
            limits[key] = {
              max: entry.Max,
              remaining: entry.Remaining,
              usedPct: entry.Max > 0
                ? Math.round(((entry.Max - entry.Remaining) / entry.Max) * 1000) / 10
                : 0,
            };
          }
          payload.limits = limits;
        }

        return jsonResult(payload);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "sf_limits",
    {
      title: "Limiti della org",
      description: `Restituisce tutti i limiti della org (governor limit giornalieri, storage, chiamate API, ecc.) con percentuale di utilizzo.

Args:
  - org (string, opzionale): alias dell'org.
  - onlyUsed (boolean, default false): mostra solo i limiti con utilizzo > 0.
  - nameContains (string, opzionale): filtra per sottostringa nel nome del limite (case-insensitive).

Returns:
{ "org": string, "count": number, "limits": [ { "name": string, "max": number, "remaining": number, "used": number, "usedPct": number } ] }

Usalo quando: sospetti di aver esaurito la quota API (errore REQUEST_LIMIT_EXCEEDED) o devi valutare lo spazio dati.`,
      inputSchema: {
        org: z.string().min(1).optional().describe("Alias dell'org"),
        onlyUsed: z.boolean().default(false).describe("Solo limiti con utilizzo maggiore di zero"),
        nameContains: z.string().min(1).optional().describe("Filtro sul nome del limite"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ org, onlyUsed, nameContains }) => {
      try {
        const { data, auth } = await getLimits(org);
        const needle = nameContains?.toLowerCase();

        const limits = Object.entries(data)
          .filter(([, v]) => v && typeof v === "object" && typeof v.Max === "number")
          .map(([name, v]) => {
            const used = v.Max - v.Remaining;
            return {
              name,
              max: v.Max,
              remaining: v.Remaining,
              used,
              usedPct: v.Max > 0 ? Math.round((used / v.Max) * 1000) / 10 : 0,
            };
          })
          .filter((l) => (onlyUsed ? l.used > 0 : true))
          .filter((l) => (needle ? l.name.toLowerCase().includes(needle) : true))
          .sort((a, b) => b.usedPct - a.usedPct);

        return jsonResult({ org: auth.alias, count: limits.length, limits });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
