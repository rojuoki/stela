import { sanitizeIoPostgresText } from "./postgres-sanitize";

export interface IoProviderFailure {
  code: "provider_credit_exhausted" | "runner_incomplete";
  message: string;
}

export function classifyIoProviderFailure(value: unknown): IoProviderFailure {
  const raw = sanitizeIoPostgresText(typeof value === "string" ? value : "");
  if (/HTTP 402|credits? is not enough|recharge/i.test(raw)) {
    return {
      code: "provider_credit_exhausted",
      message: "The external data provider has no remaining credit. Confirmed posts were saved.",
    };
  }
  return {
    code: "runner_incomplete",
    message: raw || "Acquisition did not reach a terminal resolved result",
  };
}
