import { NextRequest, NextResponse } from "next/server";
import { createUser, createToken, createAuthResponse } from "@/lib/auth";
import { giveCredits } from "@/lib/repository";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, name } = body;

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: "Email, password, and name are required" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    // Validate password strength
    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long" },
        { status: 400 }
      );
    }

    // Validate name
    if (name.trim().length < 1) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    // Create user
    const user = await createUser(email, password, name.trim());
    if (!user) {
      return NextResponse.json(
        { error: "User already exists with this email" },
        { status: 409 }
      );
    }

    // Give new user 3 free credits
    try {
      giveCredits(user.id, 3, "New user signup bonus");
    } catch (error) {
      console.error('Failed to give signup credits:', error);
      // Don't fail signup if credit granting fails
    }

    // Create token
    const token = await createToken(user);

    // Return success response with auth cookie
    return createAuthResponse(token, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });

  } catch (error) {
    console.error("[auth/signup] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}