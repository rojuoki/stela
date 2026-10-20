import { NextRequest, NextResponse } from "next/server";
import { getCachedIoProfile, getOrFetchIoProfile, IoProfileError } from "@/lib/io/profile";
import { getIoPublicPreviewState, requestIoPublicPreview } from "@/lib/io/public-preview";
import { enforceIoPreviewRateLimit } from "@/lib/io/rate-limit";
import { ioLog } from "@/lib/io/log";
import { normalizeIoUsername } from "@/lib/io/validation";
import { wakeIoWorker } from "@/lib/io/worker-wake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = normalizeIoUsername(body.username);
  if (!username) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  try {
    const cachedAccount = await getCachedIoProfile(username);
    if (cachedAccount) {
      if (cachedAccount.protected) {
        return NextResponse.json({ error: "Posts from private accounts cannot be fetched." }, { status: 409 });
      }
      const state = await getIoPublicPreviewState(cachedAccount.username);
      if (state.complete) return NextResponse.json({ kind: "ready", ...state });
      if (state.run && ["queued", "running"].includes(state.run.status)) {
        return NextResponse.json({ kind: "queued", run: state.run, reused: true }, { status: 202 });
      }
    }
    const limited = await enforceIoPreviewRateLimit(request);
    if (limited) return limited;
    const account = cachedAccount || await getOrFetchIoProfile(username);
    if (account.protected) {
      return NextResponse.json({ error: "Posts from private accounts cannot be fetched." }, { status: 409 });
    }
    const result = await requestIoPublicPreview(account.username);
    if (result.kind === "queued") {
      void wakeIoWorker("public_preview");
    }
    return NextResponse.json(result, { status: result.kind === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof IoProfileError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    ioLog("error", "preview_request_failed", { username, error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Couldn’t prepare the free preview" },
      { status: 409 },
    );
  }
}
