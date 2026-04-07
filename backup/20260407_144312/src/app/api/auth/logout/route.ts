import { NextRequest } from "next/server";
import { createLogoutResponse } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    // Clear auth cookie and return success
    return createLogoutResponse({ success: true });

  } catch (error) {
    console.error("[auth/logout] Error:", error);
    return createLogoutResponse({ error: "Internal server error" });
  }
}