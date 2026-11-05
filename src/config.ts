import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Alias usato quando un tool non riceve il parametro `org`. */
  defaultOrg?: string;
  /**
   * Versione API Salesforce da forzare per le chiamate REST.
   * Se assente si usa quella dichiarata dalla org (via `sf org display`).
   */
  apiVersion?: string;
  /** Dimensione pagina di default per sf_soql (200-2000). */
  pageSizeDefault: number;
  /** Cartella dove finiscono gli export CSV/JSON. */
  exportDir: string;
  /** Tetto massimo di record scaricabili in un export. */
  maxExportRecords: number;
  /** Alias considerati di produzione (riservato ai guardrail di scrittura, v0.2). */
  productionAliases: string[];
  /** Consente le scritture sugli alias di produzione (riservato, v0.2). */
  allowWriteOnProduction: boolean;
  /** Percorso esplicito del binario `sf`, se non è nel PATH. */
  sfCliPath?: string;
  /** TTL della cache in memoria dell'access token, in secondi. */
  tokenTtlSeconds: number;
  /**
   * Timeout dei comandi della CLI, in secondi. Tienilo sotto il timeout del
   * client MCP (di solito 60 s), altrimenti il client abortisce per primo e
   * l'errore che arriva all'agente non spiega nulla.
   */
  cliTimeoutSeconds: number;
  /** Timeout della risoluzione dell'access token, in secondi. */
  authTimeoutSeconds: number;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = join(homedir(), ".orgmcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULTS: Config = {
  defaultOrg: "myorg",
  apiVersion: undefined,
  pageSizeDefault: 200,
  exportDir: join(PACKAGE_ROOT, "exports"),
  maxExportRecords: 250_000,
  productionAliases: [],
  allowWriteOnProduction: false,
  tokenTtlSeconds: 600,
  cliTimeoutSeconds: 45,
  authTimeoutSeconds: 25,
};

function readConfigFile(): Partial<Config> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<Config>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error(
      `[orgmcp] config.json non valido (${CONFIG_FILE}), uso i default: ${
        (err as Error).message
      }`,
    );
    return {};
  }
}

function loadConfig(): Config {
  const fromFile = readConfigFile();
  const env = process.env;

  const merged: Config = {
    ...DEFAULTS,
    ...fromFile,
    defaultOrg: env.ORGMCP_DEFAULT_ORG ?? fromFile.defaultOrg ?? DEFAULTS.defaultOrg,
    apiVersion: env.ORGMCP_API_VERSION ?? fromFile.apiVersion,
    pageSizeDefault: num(
      env.ORGMCP_PAGE_SIZE,
      fromFile.pageSizeDefault ?? DEFAULTS.pageSizeDefault,
    ),
    exportDir: expandTilde(
      env.ORGMCP_EXPORT_DIR ?? fromFile.exportDir ?? DEFAULTS.exportDir,
    ),
    sfCliPath: env.ORGMCP_SF_PATH ?? fromFile.sfCliPath,
    cliTimeoutSeconds: num(
      env.ORGMCP_CLI_TIMEOUT,
      fromFile.cliTimeoutSeconds ?? DEFAULTS.cliTimeoutSeconds,
    ),
    authTimeoutSeconds: num(
      env.ORGMCP_AUTH_TIMEOUT,
      fromFile.authTimeoutSeconds ?? DEFAULTS.authTimeoutSeconds,
    ),
    productionAliases: fromFile.productionAliases ?? DEFAULTS.productionAliases,
  };

  if (!isAbsolute(merged.exportDir)) {
    merged.exportDir = resolve(PACKAGE_ROOT, merged.exportDir);
  }
  merged.pageSizeDefault = Math.min(2000, Math.max(200, merged.pageSizeDefault));

  return merged;
}

export const config = loadConfig();
export const configPath = CONFIG_FILE;
export const packageRoot = PACKAGE_ROOT;
