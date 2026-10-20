import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ioPgQuery } from "./pg-db";
import { ioLog } from "./log";

type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowSeconds: number;
  global?: boolean;
};

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function hashSubject(scope: string, subject: string): string {
  const salt = process.env.STELA_IO_RATE_LIMIT_SALT
    || process.env.STELA_IO_AUTH_SECRET
    || "stela-io-local-rate-limit";
  return createHash("sha256").update(`${salt}:${scope}:${subject}`).digest("hex");
}

export async function consumeIoRateLimit(
  scope: string,
  subject: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowMilliseconds = windowSeconds * 1_000;
  const windowStartMilliseconds = Math.floor(now / windowMilliseconds) * windowMilliseconds;
  const windowStart = new Date(windowStartMilliseconds);
  const expiresAt = new Date(windowStartMilliseconds + windowMilliseconds * 2);
  const result = await ioPgQuery<{ request_count: number }>(
    `INSERT INTO io_request_limits (
       scope, subject_hash, window_start, request_count, expires_at
     ) VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (scope, subject_hash, window_start)
     DO UPDATE SET
       request_count = io_request_limits.request_count + 1,
       expires_at = EXCLUDED.expires_at
     WHERE io_request_limits.request_count < $5
     RETURNING request_count`,
    [scope, hashSubject(scope, subject), windowStart, expiresAt, limit],
  );
  const count = result.rows[0]?.request_count;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStartMilliseconds + windowMilliseconds - now) / 1_000),
  );
  return {
    allowed: typeof count === "number",
    limit,
    remaining: typeof count === "number" ? Math.max(0, limit - count) : 0,
    retryAfterSeconds,
  };
}

async function enforcePolicies(request: NextRequest, policies: RateLimitPolicy[]): Promise<NextResponse | null> {
  const address = clientAddress(request);
  for (const policy of policies) {
    const result = await consumeIoRateLimit(
      policy.scope,
      policy.global ? "global" : address,
      policy.limit,
      policy.windowSeconds,
    );
    if (!result.allowed) {
      ioLog("warn", "rate_limit_rejected", { scope: policy.scope, retryAfterSeconds: result.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please wait and try again." },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfterSeconds),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  }
  return null;
}

export function enforceIoLoginRateLimit(request: NextRequest): Promise<NextResponse | null> {
  return enforcePolicies(request, [{
    scope: "auth-login",
    limit: positiveInteger(process.env.STELA_IO_LOGIN_RATE_LIMIT, 10),
    windowSeconds: positiveInteger(process.env.STELA_IO_LOGIN_RATE_WINDOW_SECONDS, 15 * 60),
  }]);
}

export function enforceIoSignupRateLimit(request: NextRequest): Promise<NextResponse | null> {
  return enforcePolicies(request, [{
    scope: "auth-signup",
    limit: positiveInteger(process.env.STELA_IO_SIGNUP_RATE_LIMIT, 5),
    windowSeconds: positiveInteger(process.env.STELA_IO_SIGNUP_RATE_WINDOW_SECONDS, 60 * 60),
  }]);
}

export function enforceIoPreviewRateLimit(request: NextRequest): Promise<NextResponse | null> {
  return enforcePolicies(request, [
    {
      scope: "preview-ip",
      limit: positiveInteger(process.env.STELA_IO_PREVIEW_RATE_LIMIT, 10),
      windowSeconds: positiveInteger(process.env.STELA_IO_PREVIEW_RATE_WINDOW_SECONDS, 60 * 60),
    },
    {
      scope: "preview-global",
      limit: positiveInteger(process.env.STELA_IO_PREVIEW_GLOBAL_LIMIT, 100),
      windowSeconds: positiveInteger(process.env.STELA_IO_PREVIEW_GLOBAL_WINDOW_SECONDS, 24 * 60 * 60),
      global: true,
    },
  ]);
}
