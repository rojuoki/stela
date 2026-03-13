import * as jose from 'jose';
import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';

// JWT Configuration
const JWT_SECRET = process.env.AUTH_SECRET || 'stela-auth-secret-key-phase1-development-only';
const secret = new TextEncoder().encode(JWT_SECRET);

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface SessionData {
  user: User;
  expires: string;
}

/**
 * Create a JWT token for a user
 */
export async function createToken(user: User): Promise<string> {
  const jwt = await new jose.SignJWT({ 
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    }
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
  
  return jwt;
}

/**
 * Verify and parse a JWT token
 */
export async function verifyToken(token: string): Promise<User | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    
    if (payload.user && typeof payload.user === 'object') {
      const user = payload.user as any;
      if (user.id && user.email && user.name) {
        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract JWT token from request cookies or Authorization header
 */
export function getTokenFromRequest(req: NextRequest): string | null {
  // Check Authorization header first
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  
  // Check cookies
  const cookieToken = req.cookies.get('auth-token')?.value;
  if (cookieToken) {
    return cookieToken;
  }
  
  return null;
}

/**
 * Get user from JWT token in request
 */
export async function getUserFromRequest(req: NextRequest): Promise<User | null> {
  const token = getTokenFromRequest(req);
  if (!token) {
    return null;
  }
  
  return verifyToken(token);
}

/**
 * Hash password for storage
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify password against hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Create response with auth token cookie
 */
export function createAuthResponse(token: string, data?: any): NextResponse {
  const response = NextResponse.json(data || { success: true });
  
  // Set secure HTTP-only cookie
  response.cookies.set('auth-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    path: '/',
  });
  
  return response;
}

/**
 * Create response that clears auth token
 */
export function createLogoutResponse(data?: any): NextResponse {
  const response = NextResponse.json(data || { success: true });
  
  response.cookies.set('auth-token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  
  return response;
}

/**
 * For Phase 1: Simple in-memory user store
 * TODO: Replace with database in later phases
 */
interface StoredUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

const users = new Map<string, StoredUser>();

export async function createUser(email: string, password: string, name: string): Promise<User | null> {
  // Check if user already exists
  if (findUserByEmail(email)) {
    return null; // User already exists
  }
  
  const user: StoredUser = {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    email,
    name,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  
  users.set(email, user);
  
  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
}

export function findUserByEmail(email: string): StoredUser | null {
  return users.get(email) || null;
}

export async function authenticateUser(email: string, password: string): Promise<User | null> {
  const storedUser = findUserByEmail(email);
  if (!storedUser) {
    return null;
  }
  
  const isValid = await verifyPassword(password, storedUser.passwordHash);
  if (!isValid) {
    return null;
  }
  
  return {
    id: storedUser.id,
    email: storedUser.email,
    name: storedUser.name,
  };
}