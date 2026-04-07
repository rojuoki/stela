import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    console.log("[checkout/unlock] === DEBUG INFO START ===");
    console.log("[checkout/unlock] NODE_ENV:", process.env.NODE_ENV);
    console.log("[checkout/unlock] Processing guest paid unlock");

    const body = await req.json();
    const { username } = body;

    console.log("[checkout/unlock] Requested unlock:", { username });

    // Validate username
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      console.log("[checkout/unlock] Invalid username:", username);
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    // Check for price configuration
    if (!process.env.STRIPE_PRICE_PAID_UNLOCK) {
      console.log("[checkout/unlock] Missing price configuration");
      return NextResponse.json(
        { error: "Unlock purchase configuration missing: STRIPE_PRICE_PAID_UNLOCK not set" },
        { status: 500 }
      );
    }

    // Normalize username (remove @ if present)
    const normalizedUsername = username.trim().replace(/^@/, '');

    console.log("[checkout/unlock] Creating Stripe session...");
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // One-time payment for unlock
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_PAID_UNLOCK,
        quantity: 1,
      }],
      metadata: {
        type: 'unlock',
        username: normalizedUsername
      },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/?temp-unlock=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/user/${encodeURIComponent(normalizedUsername)}`,
    });

    console.log("[checkout/unlock] Session created successfully:");
    console.log("  - Session ID:", session.id);
    console.log("  - Session URL:", session.url);
    console.log("  - Metadata:", session.metadata);
    console.log("  - Mode:", session.mode);
    console.log("[checkout/unlock] === DEBUG INFO END ===");

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("[checkout/unlock] Error creating session:", error);
    if (error instanceof Error) {
      console.error("[checkout/unlock] Error details:", {
        message: error.message,
        stack: error.stack
      });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}