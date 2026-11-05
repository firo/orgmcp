/** Tetto sulla dimensione testuale di una risposta, per non saturare il contesto. */
export const CHARACTER_LIMIT = 25_000;

/** Numero massimo di sObject restituiti da sf_describe_global in una chiamata. */
export const DESCRIBE_GLOBAL_LIMIT = 200;

/** Oltre questo numero di valori, una picklist viene riassunta invece che elencata. */
export const PICKLIST_INLINE_LIMIT = 25;

/** Versione API usata solo se la org non ne dichiara una e il config non la forza. */
export const FALLBACK_API_VERSION = "61.0";

export const SERVER_NAME = "salesforce-org-mcp-server";
export const SERVER_VERSION = "0.1.0";
