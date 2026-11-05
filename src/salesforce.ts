import { config } from "./config.js";
import { FALLBACK_API_VERSION } from "./constants.js";
import { actionable } from "./errors.js";
import { getOrgAuth, invalidateAuth, type OrgAuth } from "./sf.js";

export interface SalesforceRecord {
  attributes?: { type?: string; url?: string };
  [field: string]: unknown;
}

export interface QueryResult {
  totalSize: number;
  done: boolean;
  records: SalesforceRecord[];
  nextRecordsUrl?: string;
}

interface SalesforceApiError {
  message?: string;
  errorCode?: string;
}

interface RequestOptions {
  /** Header Sforce-Query-Options: batchSize=N */
  batchSize?: number;
  method?: "GET";
  /** Contesto usato solo per rendere più precisi i messaggi di errore. */
  context?: { tooling?: boolean };
}

/**
 * Esegue una chiamata REST autenticata. `path` può essere:
 *  - un path assoluto dell'API (`/services/data/v61.0/limits`)
 *  - un path relativo alla versione (`/limits`, `/sobjects/Account/describe`)
 */
export async function sfRest<T>(
  org: string | undefined,
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; auth: OrgAuth }> {
  let auth = await getOrgAuth(org);
  let response = await doFetch<T>(auth, path, options);

  // Token scaduto o revocato lato server: un solo retry dopo refresh.
  if (response.status === 401) {
    invalidateAuth(auth.alias);
    auth = await getOrgAuth(org, true);
    response = await doFetch<T>(auth, path, options);
  }

  if (!response.ok) {
    throwApiError(response.status, response.errors, auth.alias, options.context);
  }

  return { data: response.data as T, auth };
}

interface FetchOutcome<T> {
  ok: boolean;
  status: number;
  data?: T;
  errors: SalesforceApiError[];
}

async function doFetch<T>(
  auth: OrgAuth,
  path: string,
  options: RequestOptions,
): Promise<FetchOutcome<T>> {
  const url = buildUrl(auth, path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  };
  if (options.batchSize) {
    headers["Sforce-Query-Options"] = `batchSize=${options.batchSize}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: options.method ?? "GET", headers });
  } catch (err) {
    return actionable(
      `Chiamata a Salesforce fallita (rete): ${(err as Error).message}`,
      `Verifica la connessione e che ${auth.instanceUrl} sia raggiungibile.`,
    );
  }

  const text = await res.text();
  let body: unknown = undefined;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (res.ok) {
    return { ok: true, status: res.status, data: body as T, errors: [] };
  }

  const errors: SalesforceApiError[] = Array.isArray(body)
    ? (body as SalesforceApiError[])
    : body && typeof body === "object"
      ? [body as SalesforceApiError]
      : [{ message: typeof body === "string" ? body : res.statusText }];

  return { ok: false, status: res.status, errors };
}

/**
 * Versione API da usare: quella forzata nel config, altrimenti quella dichiarata
 * dalla org (che può essere più recente del fallback compilato qui dentro).
 */
export function apiVersionFor(auth: OrgAuth): string {
  return config.apiVersion ?? auth.apiVersion ?? FALLBACK_API_VERSION;
}

function buildUrl(auth: OrgAuth, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (clean.startsWith("/services/")) return `${auth.instanceUrl}${clean}`;
  return `${auth.instanceUrl}/services/data/v${apiVersionFor(auth)}${clean}`;
}

function throwApiError(
  status: number,
  errors: SalesforceApiError[],
  alias: string,
  context?: { tooling?: boolean },
): never {
  const first = errors[0] ?? {};
  const code = first.errorCode ?? `HTTP_${status}`;
  const message = first.message ?? "errore non specificato";
  const all = errors.length > 1 ? ` (+${errors.length - 1} altri errori)` : "";

  let hint: string | undefined;
  switch (code) {
    case "INVALID_SESSION_ID":
      hint = `Sessione non valida per l'org "${alias}": rifai il login con \`sf_login\`.`;
      break;
    case "MALFORMED_QUERY":
      hint = "La sintassi SOQL non è valida: controlla parentesi, virgole e nomi di campo.";
      break;
    case "INVALID_FIELD":
      hint =
        "Campo inesistente o non accessibile: verifica i nomi API con `sf_describe_object`.";
      break;
    case "INVALID_TYPE":
      hint = context?.tooling
        ? "Oggetto non disponibile nella Tooling API con questo utente: controlla il nome, " +
          "oppure servono permessi di setup (es. 'View Setup and Configuration', 'Author Apex')."
        : "Oggetto inesistente o non accessibile. Tre cause tipiche: nome API sbagliato " +
          "(verifica con `sf_describe_global`); oggetto di setup come ApexClass, Flow o " +
          "FieldDefinition (riprova con `tooling: true`); permessi mancanti sull'oggetto.";
      break;
    case "INSUFFICIENT_ACCESS":
    case "INSUFFICIENT_ACCESS_OR_READONLY":
      hint = "L'utente autenticato non ha i permessi necessari su questo oggetto o campo.";
      break;
    case "REQUEST_LIMIT_EXCEEDED":
      hint = "Quota API della org esaurita: controlla con `sf_limits` e attendi il reset.";
      break;
    case "QUERY_TIMEOUT":
      hint = "Query troppo pesante: aggiungi filtri selettivi su campi indicizzati o riduci l'intervallo di date.";
      break;
    case "NOT_FOUND":
    case "HTTP_404":
      hint = "Risorsa inesistente: controlla il nome dell'oggetto o la versione API.";
      break;
    default:
      hint = undefined;
  }

  return actionable(`Salesforce ha risposto ${code}: ${message}${all}`, hint);
}

// ---------------------------------------------------------------------------
// Operazioni di alto livello
// ---------------------------------------------------------------------------

export async function runQuery(
  org: string | undefined,
  soql: string,
  opts: { pageSize?: number; tooling?: boolean } = {},
): Promise<{ result: QueryResult; auth: OrgAuth }> {
  const endpoint = opts.tooling ? "/tooling/query" : "/query";
  const path = `${endpoint}?q=${encodeURIComponent(soql)}`;
  const { data, auth } = await sfRest<QueryResult>(org, path, {
    batchSize: opts.pageSize,
    context: { tooling: opts.tooling },
  });
  return { result: data, auth };
}

export async function runQueryMore(
  org: string | undefined,
  nextRecordsUrl: string,
): Promise<{ result: QueryResult; auth: OrgAuth }> {
  const { data, auth } = await sfRest<QueryResult>(org, nextRecordsUrl);
  return { result: data, auth };
}

/** Scorre tutte le pagine fino a `maxRecords`, per gli export. */
export async function runQueryAll(
  org: string | undefined,
  soql: string,
  opts: { tooling?: boolean; maxRecords?: number } = {},
): Promise<{ records: SalesforceRecord[]; totalSize: number; truncated: boolean; auth: OrgAuth }> {
  const cap = Math.min(opts.maxRecords ?? config.maxExportRecords, config.maxExportRecords);
  const first = await runQuery(org, soql, { pageSize: 2000, tooling: opts.tooling });
  const records = [...first.result.records];
  let next = first.result.nextRecordsUrl;

  while (next && records.length < cap) {
    const page = await runQueryMore(org, next);
    records.push(...page.result.records);
    next = page.result.nextRecordsUrl;
  }

  const truncated = records.length > cap || Boolean(next);
  return {
    records: records.slice(0, cap),
    totalSize: first.result.totalSize,
    truncated,
    auth: first.auth,
  };
}

export interface GlobalDescribeSObject {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  keyPrefix: string | null;
  customSetting?: boolean;
}

export async function describeGlobal(org: string | undefined) {
  return sfRest<{ sobjects: GlobalDescribeSObject[]; encoding?: string; maxBatchSize?: number }>(
    org,
    "/sobjects",
  );
}

export interface PicklistEntry {
  value: string;
  label: string;
  active: boolean;
  defaultValue: boolean;
}

export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  unique: boolean;
  externalId: boolean;
  defaultedOnCreate: boolean;
  calculated: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  picklistValues?: PicklistEntry[];
  inlineHelpText?: string | null;
}

export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
}

export interface ObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  keyPrefix: string | null;
  fields: FieldDescribe[];
  childRelationships: ChildRelationship[];
  recordTypeInfos?: { name: string; recordTypeId: string; available: boolean; master: boolean }[];
}

export async function describeObject(org: string | undefined, sobject: string) {
  const safe = sobject.trim();
  if (!/^[A-Za-z0-9_]+$/.test(safe)) {
    return actionable(
      `Nome sObject non valido: "${sobject}".`,
      "Usa il nome API, per esempio `Account` o `My_Object__c`.",
    );
  }
  return sfRest<ObjectDescribe>(org, `/sobjects/${safe}/describe`);
}

export interface OrgProfile {
  Id: string;
  Name: string;
  IsSandbox: boolean;
  OrganizationType: string;
  InstanceName: string;
  TrialExpirationDate: string | null;
}

/**
 * Legge l'oggetto Organization: è l'unica fonte affidabile per sapere se una org
 * è una sandbox (username e instance URL non sono indicatori attendibili).
 * Restituisce null se l'utente non ha accesso all'oggetto.
 */
export async function getOrgProfile(
  org: string | undefined,
): Promise<{ profile: OrgProfile | null; auth: OrgAuth }> {
  const soql =
    "SELECT Id, Name, IsSandbox, OrganizationType, InstanceName, TrialExpirationDate FROM Organization LIMIT 1";
  try {
    const { result, auth } = await runQuery(org, soql, { pageSize: 200 });
    const record = result.records?.[0] as unknown as OrgProfile | undefined;
    return { profile: record ?? null, auth };
  } catch {
    const auth = await getOrgAuth(org);
    return { profile: null, auth };
  }
}

export type OrgLimits = Record<string, { Max: number; Remaining: number }>;

export async function getLimits(org: string | undefined) {
  return sfRest<OrgLimits>(org, "/limits");
}
