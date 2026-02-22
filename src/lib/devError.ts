/**
 * Dev-only request error/delay injection.
 * Reads x-stela-dev-error (and x-stela-dev-delay-ms) headers set by apiFetch
 * and short-circuits the route with the requested error response.
 *
 * Usage at the top of any route handler:
 *   const injected = await maybeInjectDevError(req);
 *   if (injected) return injected;
 *
 * Safe no-op in production (NEXT_PUBLIC_DEV_PANEL !== "1").
 */

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function maybeInjectDevError(
  req: Request,
): Promise<Response | null> {
  if (!DEV_PANEL) return null;

  const mode = req.headers.get("x-stela-dev-error");
  if (!mode || mode === "none") return null;

  console.log(`[dev] error injection: mode=${mode}`);

  if (mode === "429") {
    return Response.json(
      { error: "DEV_FORCED_429", message: "Simulated rate limit (dev)" },
      { status: 429 },
    );
  }

  if (mode === "500") {
    return Response.json(
      { error: "DEV_FORCED_500", message: "Simulated server error (dev)" },
      { status: 500 },
    );
  }

  if (mode === "timeout") {
    // Hold for 30 s then return 504 — simulates a hung server / gateway timeout.
    await new Promise((r) => setTimeout(r, 30_000));
    return Response.json(
      { error: "DEV_FORCED_TIMEOUT", message: "Simulated timeout (dev)" },
      { status: 504 },
    );
  }

  if (mode === "delay") {
    const raw = req.headers.get("x-stela-dev-delay-ms");
    const ms = Math.max(100, Math.min(30_000, parseInt(raw ?? "2000", 10)));
    await new Promise((r) => setTimeout(r, ms));
    return null; // continue normally after delay
  }

  return null;
}
