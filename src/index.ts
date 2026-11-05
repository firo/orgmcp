#!/usr/bin/env node
/**
 * OrgMCP — server MCP per accedere a org Salesforce.
 *
 * Autenticazione: login via browser delegato alla Salesforce CLI
 * (`sf org login web`, OAuth 2.0 con PKCE). Nessuna Connected App da creare,
 * nessun segreto gestito da questo processo: i token restano nello store della CLI.
 *
 * Versione 0.1: sola lettura (SOQL, describe, limiti, gestione org).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerOrgTools } from "./tools/orgs.js";
import { registerQueryTools } from "./tools/query.js";
import { registerSchemaTools } from "./tools/schema.js";

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Accesso in sola lettura a org Salesforce. Le org sono identificate da un alias della " +
      `Salesforce CLI (default: ${config.defaultOrg ?? "nessuno"}). ` +
      "Flusso tipico: `sf_list_orgs` per vedere le org autorizzate (o `sf_login` per autenticarne una " +
      "via browser), `sf_describe_global`/`sf_describe_object` per scoprire i nomi API, poi `sf_soql` " +
      "per interrogare i dati. Per estrazioni grandi usa `exportTo: \"csv\"` invece di paginare.",
  },
);

registerOrgTools(server);
registerQueryTools(server);
registerSchemaTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout è riservato al protocollo MCP: i log vanno su stderr.
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} avviato su stdio`);
}

main().catch((err: unknown) => {
  console.error(`[${SERVER_NAME}] errore fatale:`, err);
  process.exit(1);
});
