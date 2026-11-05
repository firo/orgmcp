/**
 * Errore "azionabile": il messaggio è pensato per essere letto da un agente
 * e contiene il passo successivo da fare, non uno stack trace.
 */
export class ActionableError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(hint ? `${message}\n\nCosa fare: ${hint}` : message);
    this.name = "ActionableError";
    this.hint = hint;
  }
}

export function actionable(message: string, hint?: string): never {
  throw new ActionableError(message, hint);
}

export function describeError(err: unknown): string {
  if (err instanceof ActionableError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
