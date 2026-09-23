import { NextRequest, NextResponse } from "next/server";
import {
  createIoAuthResponse,
  createIoToken,
  createIoUserWithPassword,
} from "@/lib/io/auth";
import { IoConfigurationError, ioConfigurationMessage } from "@/lib/io/configuration-error";

export const runtime = "nodejs";

function value(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = value(body, "email");
    const password = value(body, "password");
    const name = value(body, "name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    const user = await createIoUserWithPassword(email, password, name);
    if (!user) return NextResponse.json({ error: "Email already exists" }, { status: 409 });
    return createIoAuthResponse(await createIoToken(user), { user });
  } catch (error) {
    console.error("[io/auth/signup]", error);
    if (error instanceof IoConfigurationError) {
      return NextResponse.json({ error: ioConfigurationMessage() }, { status: 503 });
    }
    return NextResponse.json({ error: "Could not create account" }, { status: 500 });
  }
}
