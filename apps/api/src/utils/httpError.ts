/**
 * Error carrying an HTTP status and a stable `error` code for the response
 * body. Throw it (instead of `return reply.send(...)`) inside locked sections:
 * a returned reply is a thenable, so awaiting it would hold the lock until the
 * response, including its onSend hooks, has been sent.
 */
export function httpError(statusCode: number, code: string, message?: string) {
  return Object.assign(new Error(message ?? code), { statusCode, errorCode: code, publicMessage: message });
}
