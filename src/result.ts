import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CHARACTER_LIMIT } from "./constants.js";
import { describeError } from "./errors.js";

type Payload = Record<string, unknown>;

/**
 * Restituisce testo JSON + structuredContent. Se la risposta sfonda il limite
 * di caratteri, dimezza ripetutamente l'array `records` (se presente) e segnala
 * il troncamento, invece di far esplodere il contesto dell'agente.
 */
export function jsonResult(payload: Payload): CallToolResult {
  let current: Payload = payload;
  let text = JSON.stringify(current, null, 2);

  if (text.length > CHARACTER_LIMIT && Array.isArray(current.records)) {
    let records = current.records as unknown[];
    const original = records.length;

    while (text.length > CHARACTER_LIMIT && records.length > 1) {
      records = records.slice(0, Math.max(1, Math.floor(records.length / 2)));
      current = {
        ...payload,
        records,
        truncated: true,
        truncationMessage:
          `Risposta troncata da ${original} a ${records.length} record per limiti di dimensione. ` +
          "Riduci i campi selezionati, aggiungi filtri WHERE, oppure usa `exportTo: \"csv\"` per il set completo.",
      };
      text = JSON.stringify(current, null, 2);
    }
  }

  if (text.length > CHARACTER_LIMIT) {
    text = `${text.slice(0, CHARACTER_LIMIT)}\n… [output troncato]`;
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: current,
  };
}

export function errorResult(err: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `Errore: ${describeError(err)}` }],
    isError: true,
  };
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
