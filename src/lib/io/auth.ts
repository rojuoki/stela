import bcrypt from "bcryptjs";
import * as jose from "jose";
import { NextRequest, NextResponse } from "next/server";
import {
  createIoUser,
  getIoUserByEmail,
  type IoUser,
} from "./pg-users";

const COOKIE_NAME = "stela-io-auth-token";

function secret(): Uint8Array {
  const value = process.env.STELA_IO_AUTH_SECRET;
  if (!value) {
    throw new Error("STELA_IO_AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(value);
}

export async function createIoToken(user: IoUser): Promise<string> {
  return new jose.SignJWT({ user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
}

export async function getIoUserFromRequest(request: NextRequest): Promise<IoUser | null> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, secret());
    const user = payload.user;
    if (!user || typeof user !== "object") return null;
    const value = user as Record<string, unknown>;
    if (
      typeof value.id !== "string"
      || typeof value.email !== "string"
      || typeof value.name !== "string"
    ) return null;
    return { id: value.id, email: value.email, name: value.name };
  } catch {
    return null;
  }
}

export async function createIoUserWithPassword(
  email: string,
  password: string,
  name: string,
): Promise<IoUser | null> {
  return createIoUser(email, await bcrypt.hash(password, 12), name);
}

export async function authenticateIoUser(
  email: string,
  password: string,
): Promise<IoUser | null> {
  const user = await getIoUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return null;
  return { id: user.id, email: user.email, name: user.name };
}

export function createIoAuthResponse(token: string, body: unknown): NextResponse {
  const response = NextResponse.json(body);
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
  return response;
}

export function createIoLogoutResponse(body: unknown): NextResponse {
  const response = NextResponse.json(body);
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return response;
}
