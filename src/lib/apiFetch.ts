/** Fetch with authentication cookies. Development panel overrides are removed. */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}
