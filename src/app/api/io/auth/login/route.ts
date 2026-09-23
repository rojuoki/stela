import { NextRequest, NextResponse } from "next/server";
import { authenticateIoUser, createIoAuthResponse, createIoToken } from "@/lib/io/auth";
import { IoConfigurationError, ioConfigurationMessage } from "@/lib/io/configuration-error";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    const user = await authenticateIoUser(email, password);
    if (!user) return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    return createIoAuthResponse(await createIoToken(user), { user });
  } catch (error) {
    console.error("[io/auth/login]", error);
    if (error instanceof IoConfigurationError) {
      return NextResponse.json({ error: ioConfigurationMessage() }, { status: 503 });
    }
    return NextResponse.json({ error: "Could not sign in" }, { status: 500 });
  }
}
