import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { config } from "./config.js";
import { FALLBACK_API_VERSION } from "./constants.js";
import { actionable } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Le app GUI su macOS (e quindi i server MCP che lanciano) ereditano un PATH
 * minimale: `sf` installata via npm/brew/volta non si trova. Ampliamo il PATH
 * con le posizioni standard prima di cercare il binario.
 */
const EXTRA_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  join(homedir(), ".volta", "bin"),
  join(homedir(), ".npm-global", "bin"),
  join(homedir(), ".nvm", "versions", "node"),
  join(homedir(), ".local", "bin"),
];

function buildEnv(): NodeJS.ProcessEnv {
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  for (const p of EXTRA_PATHS) {
    if (!parts.includes(p)) parts.push(p);
  }
  return {
    ...process.env,
    PATH: parts.join(":"),
    // La CLI Salesforce non deve mai aprire prompt interattivi né telemetria.
    SF_AUTOUPDATE_DISABLE: "true",
    SF_DISABLE_TELEMETRY: "true",
    SFDX_DISABLE_TELEMETRY: "true",
  };
}

const ENV = buildEnv();

let resolvedBinary: string | undefined;
let resolvedVersion: string | undefined;

/**
 * Se `sfCliPath` è configurato esplicitamente è l'unico candidato: ripiegare in
 * silenzio su un'altra `sf` del PATH significherebbe usare una CLI diversa da
 * quella richiesta, con org e configurazioni potenzialmente diverse.
 */
function candidateBinaries(): string[] {
  if (config.sfCliPath) return [config.sfCliPath];
  const list = ["sf"];
  for (const dir of EXTRA_PATHS) list.push(join(dir, "sf"));
  return list;
}

/** Trova il binario `sf` una volta sola e lo memorizza. */
export async function resolveSfBinary(): Promise<string> {
  if (resolvedBinary) return resolvedBinary;

  let timedOut: string | undefined;

  for (const candidate of candidateBinaries()) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    try {
      // `sf --version` stampa testo semplice, non JSON: niente runSf qui.
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        env: ENV,
        timeout: AUTH_TIMEOUT_MS,
      });
      resolvedBinary = candidate;
      resolvedVersion = stdout.trim().split("\n")[0]?.trim();
      return candidate;
    } catch (err) {
      // Un binario che esiste ma resta appeso è un problema diverso da uno assente.
      if ((err as { killed?: boolean }).killed) timedOut = candidate;
    }
  }

  if (timedOut) {
    return actionable(
      `La Salesforce CLI non ha risposto entro ${config.authTimeoutSeconds} secondi al comando \`${timedOut} --version\`.`,
      "L'installazione sembra bloccata o danneggiata: provala a mano in un terminale. " +
        "Se resta appesa, reinstallala con `npm install -g @salesforce/cli`.",
    );
  }

  if (config.sfCliPath) {
    return actionable(
      `Il percorso configurato in \`sfCliPath\` non è una Salesforce CLI funzionante: ${config.sfCliPath}`,
      "Correggi `sfCliPath` in ~/.orgmcp/config.json (o rimuovilo per cercare `sf` nel PATH). " +
        "Verifica il percorso con `which sf`.",
    );
  }

  return actionable(
    "Salesforce CLI (`sf`) non trovata.",
    "Installala con `npm install -g @salesforce/cli`, poi verifica con `sf --version`. " +
      "Se è già installata in un percorso non standard, imposta `sfCliPath` in ~/.orgmcp/config.json.",
  );
}

export interface SfVersion {
  /** Riga completa, es. "@salesforce/cli/2.116.6 darwin-arm64 node-v22.21.1". */
  raw: string;
  /** Solo il numero di versione della CLI, es. "2.116.6". */
  cli: string | null;
  /** Versione di Node usata dalla CLI, es. "v22.21.1". */
  node: string | null;
}

/** Versione della Salesforce CLI, letta da `sf --version` (output testuale). */
export async function getSfVersion(): Promise<SfVersion> {
  await resolveSfBinary();
  const raw = resolvedVersion ?? "";
  return {
    raw,
    cli: /@salesforce\/cli\/([\d.]+)/.exec(raw)?.[1] ?? null,
    node: /node-(v[\d.]+)/.exec(raw)?.[1] ?? null,
  };
}

interface SfJsonResponse<T> {
  status?: number;
  result?: T;
  message?: string;
  name?: string;
  warnings?: unknown[];
}

/**
 * Timeout di default dei comandi CLI. Deve restare sotto il timeout del client
 * MCP (tipicamente 60 s): altrimenti il client abortisce per primo e l'agente
 * riceve un generico "Request timed out" invece di un errore spiegato.
 */
const DEFAULT_CLI_TIMEOUT_MS = config.cliTimeoutSeconds * 1000;
/** Risoluzione dell'access token: deve essere rapida, è nel percorso di ogni chiamata. */
const AUTH_TIMEOUT_MS = config.authTimeoutSeconds * 1000;

export interface SfRunOptions {
  timeoutMs?: number;
  /** Se true, non lancia eccezione su exit code != 0: restituisce il payload JSON di errore. */
  tolerateFailure?: boolean;
}

/**
 * Esegue un comando `sf ... --json` e restituisce `result`.
 * La CLI stampa JSON su stdout anche in caso di errore, quindi lo parsiamo comunque.
 */
export async function runSf<T>(args: string[], options: SfRunOptions = {}): Promise<T> {
  const binary = await resolveSfBinary();
  const argv = args.includes("--json") ? args : [...args, "--json"];

  let stdout = "";
  let stderr = "";
  let failed = false;

  try {
    const res = await execFileAsync(binary, argv, {
      env: ENV,
      timeout: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    failed = true;
    if (!stdout.trim()) {
      if (e.killed) {
        const seconds = Math.round((options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS) / 1000);
        return actionable(
          `La Salesforce CLI non ha risposto entro ${seconds} secondi: \`sf ${argv.join(" ")}\`.`,
          "Di solito significa che il refresh token dell'org è scaduto o l'org non è più " +
            "raggiungibile (scaduta, disattivata, rete bloccata). Provalo a mano con " +
            `\`sf org display --target-org <alias>\`: se resta appeso o dà errore, rifai il login con \`sf_login\`.`,
        );
      }
      return actionable(
        `Errore eseguendo \`sf ${argv.join(" ")}\`: ${e.message ?? "errore sconosciuto"}`,
        stderr.trim() ? `Output della CLI: ${stderr.trim().slice(0, 500)}` : undefined,
      );
    }
  }

  let parsed: SfJsonResponse<T>;
  try {
    parsed = JSON.parse(extractJson(stdout)) as SfJsonResponse<T>;
  } catch {
    return actionable(
      `Output non JSON da \`sf ${argv.join(" ")}\`.`,
      `Primi 500 caratteri: ${stdout.slice(0, 500)}`,
    );
  }

  const ok = !failed && (parsed.status === 0 || parsed.status === undefined);
  if (!ok && !options.tolerateFailure) {
    const message = parsed.message ?? "errore non specificato";
    return actionable(
      `La Salesforce CLI ha restituito un errore (${parsed.name ?? "Error"}): ${message}`,
      hintForCliError(parsed.name, message),
    );
  }

  return (parsed.result ?? (parsed as unknown)) as T;
}

/** La CLI a volte precede il JSON con righe di warning: isoliamo il primo oggetto JSON. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const start = trimmed.search(/[[{]/);
  return start >= 0 ? trimmed.slice(start) : trimmed;
}

function hintForCliError(name: string | undefined, message: string): string | undefined {
  const text = `${name ?? ""} ${message}`.toLowerCase();
  if (text.includes("no authorization information") || text.includes("no default env")) {
    return "L'alias non è autorizzato su questa macchina: usa il tool `sf_login` con quell'alias.";
  }
  if (text.includes("expired") || text.includes("invalid_grant") || text.includes("revoked")) {
    return "Il refresh token non è più valido: rifai il login con `sf_login`.";
  }
  if (text.includes("namedorgnotfound")) {
    return "Alias inesistente: controlla con `sf_list_orgs` oppure autorizza l'org con `sf_login`.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Org auth: risoluzione alias -> access token, con cache in memoria
// ---------------------------------------------------------------------------

export interface OrgDisplay {
  id?: string;
  accessToken?: string;
  instanceUrl?: string;
  username?: string;
  alias?: string;
  apiVersion?: string;
  connectedStatus?: string;
  clientId?: string;
  status?: string;
  expirationDate?: string;
}

export interface OrgAuth {
  alias: string;
  accessToken: string;
  instanceUrl: string;
  username: string;
  orgId: string;
  apiVersion: string;
}

interface CacheEntry {
  auth: OrgAuth;
  fetchedAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

export function resolveAlias(org?: string): string {
  const alias = org?.trim() || config.defaultOrg;
  if (!alias) {
    return actionable(
      "Nessuna org indicata e nessun alias di default configurato.",
      "Passa il parametro `org`, oppure imposta `defaultOrg` in ~/.orgmcp/config.json.",
    );
  }
  return alias;
}

export function invalidateAuth(alias: string): void {
  tokenCache.delete(alias);
}

/**
 * Access token tramite @salesforce/core (la libreria usata dalla CLI stessa):
 * funziona anche quando la CLI maschera il token nell'output. Restituisce
 * undefined se la libreria non è installata o non trova l'alias.
 */
async function tokenViaSfCore(alias: string): Promise<{ accessToken: string; instanceUrl?: string } | undefined> {
  let core: typeof import("@salesforce/core");
  try {
    core = await import("@salesforce/core");
  } catch {
    return undefined;
  }
  try {
    const org = await core.Org.create({ aliasOrUsername: alias });
    await org.refreshAuth();
    const conn = org.getConnection();
    const token = conn.accessToken ?? undefined;
    if (!token || looksRedacted(token)) return undefined;
    return { accessToken: token, instanceUrl: conn.instanceUrl };
  } catch (err) {
    process.stderr.write(`[orgmcp] @salesforce/core non ha fornito il token per "${alias}": ${(err as Error).message}\n`);
    return undefined;
  }
}

function looksRedacted(token?: string): boolean {
  if (!token) return true;
  const t = token.trim();
  return t.startsWith("[") || /redact/i.test(t);
}

/** force://<clientId>:<clientSecret>:<refreshToken>@<host> -> nuovo access token. */
async function exchangeAuthUrl(
  authUrl: string,
  fallbackInstance?: string,
): Promise<{ accessToken: string; instanceUrl?: string }> {
  const body = authUrl.replace(/^force:\/\//, "");
  const at = body.lastIndexOf("@");
  if (at < 0) return actionable("sfdxAuthUrl in formato inatteso.", "Rifai il login con `sf_login`.");
  const creds = body.slice(0, at);
  const host = body.slice(at + 1).replace(/\/+$/, "");
  const [clientId, clientSecret, ...rest] = creds.split(":");
  const refreshToken = rest.join(":");
  if (!clientId || !refreshToken) {
    return actionable("sfdxAuthUrl senza refresh token.", "Rifai il login con `sf_login`.");
  }
  const base = fallbackInstance || (host.startsWith("http") ? host : `https://${host}`);
  const params = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  if (clientSecret) params.set("client_secret", clientSecret);
  const res = await fetch(`${base.replace(/\/+$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; instance_url?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    return actionable(
      `Scambio del refresh token non riuscito (${json.error ?? res.status}).`,
      `${json.error_description ?? ""} Rifai il login con \`sf_login\`.`.trim(),
    );
  }
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

export async function getOrgAuth(org?: string, forceRefresh = false): Promise<OrgAuth> {
  const alias = resolveAlias(org);
  const cached = tokenCache.get(alias);
  const ttlMs = config.tokenTtlSeconds * 1000;

  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.auth;
  }

  let display = await runSf<OrgDisplay>(["org", "display", "--target-org", alias], {
    timeoutMs: AUTH_TIMEOUT_MS,
  });

  // Dalla CLI 2.15x `sf org display` restituisce "[REDACTED]" al posto del token.
  // Ripieghiamo su `--verbose` e, se anche lì è mascherato, scambiamo il refresh
  // token contenuto nello sfdxAuthUrl con un access token nuovo (OAuth refresh_token).
  if (looksRedacted(display.accessToken)) {
    // 1) Libreria ufficiale della CLI: legge il login salvato e rinnova il token.
    const viaCore = await tokenViaSfCore(alias);
    if (viaCore) {
      display = { ...display, accessToken: viaCore.accessToken, instanceUrl: viaCore.instanceUrl || display.instanceUrl };
    }
  }
  if (looksRedacted(display.accessToken)) {
    // 2) Ultimo tentativo con l'output della CLI.
    const verbose = await runSf<OrgDisplay & { sfdxAuthUrl?: string }>(
      ["org", "display", "--target-org", alias, "--verbose"],
      { timeoutMs: AUTH_TIMEOUT_MS },
    );
    if (!looksRedacted(verbose.accessToken)) {
      display = { ...display, ...verbose, accessToken: verbose.accessToken };
    } else if (verbose.sfdxAuthUrl && !/redact/i.test(verbose.sfdxAuthUrl)) {
      const fresh = await exchangeAuthUrl(verbose.sfdxAuthUrl, display.instanceUrl ?? verbose.instanceUrl);
      display = { ...display, accessToken: fresh.accessToken, instanceUrl: fresh.instanceUrl ?? display.instanceUrl };
    } else {
      return actionable(
        `La Salesforce CLI non espone più l'access token per l'org "${alias}" (valore mascherato).`,
        "Aggiorna questo server MCP oppure installa una versione della CLI che restituisca il token " +
          "(es. `npm install -g @salesforce/cli@2.150.0`), poi riavvia Claude.",
      );
    }
  }

  if (!display.accessToken || !display.instanceUrl) {
    return actionable(
      `Non riesco a ottenere un access token per l'org "${alias}".`,
      `Autorizza l'org con il tool \`sf_login\` (alias "${alias}"), oppure verifica con \`sf_list_orgs\`.`,
    );
  }
  if (display.connectedStatus && !/connected/i.test(display.connectedStatus)) {
    return actionable(
      `L'org "${alias}" risulta non connessa (stato: ${display.connectedStatus}).`,
      `Rifai il login con \`sf_login\` sull'alias "${alias}".`,
    );
  }

  const instanceUrl = display.instanceUrl.replace(/\/+$/, "");
  const auth: OrgAuth = {
    alias,
    accessToken: display.accessToken,
    instanceUrl,
    username: display.username ?? "sconosciuto",
    orgId: display.id ?? "sconosciuto",
    apiVersion: display.apiVersion ?? config.apiVersion ?? FALLBACK_API_VERSION,
  };

  tokenCache.set(alias, { auth, fetchedAt: Date.now() });
  return auth;
}

/** Versione "pubblica" dell'auth: senza token, sicura da restituire all'agente. */
export function publicAuthInfo(auth: OrgAuth) {
  return {
    alias: auth.alias,
    username: auth.username,
    orgId: auth.orgId,
    instanceUrl: auth.instanceUrl,
    apiVersion: auth.apiVersion,
  };
}
