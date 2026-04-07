import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    console.log("[checkout/subscription] === DEBUG INFO START ===");
    console.log("[checkout/subscription] NODE_ENV:", process.env.NODE_ENV);
    console.log("[checkout/subscription] STRIPE_SECRET_KEY:", process.env.STRIPE_SECRET_KEY ? `Set (${process.env.STRIPE_SECRET_KEY.substring(0, 12)}...)` : "NOT SET");
    console.log("[checkout/subscription] STRIPE_PRICE_BASIC:", process.env.STRIPE_PRICE_BASIC || "NOT SET");
    console.log("[checkout/subscription] NEXT_PUBLIC_BASE_URL:", process.env.NEXT_PUBLIC_BASE_URL || "NOT SET");
    
    const user = await getUserFromRequest(req);
    if (!user) {
      console.log("[checkout/subscription] User not authenticated");
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    
    console.log("[checkout/subscription] User:", { id: user.id, email: user.email });

    if (!process.env.STRIPE_PRICE_BASIC) {
      console.log("[checkout/subscription] STRIPE_PRICE_BASIC not configured");
      return NextResponse.json({ error: "Stripe configuration missing" }, { status: 500 });
    }

    console.log("[checkout/subscription] Creating Stripe session...");
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_BASIC,
        quantity: 1,
      }],
      metadata: {
        userId: user.id,
        type: 'subscription',
        plan: 'basic'
      },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/?subscription=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/subscribe`,
    });

    console.log("[checkout/subscription] Session created successfully:");
    console.log("  - Session ID:", session.id);
    console.log("  - Session URL:", session.url);
    console.log("  - Metadata:", session.metadata);
    console.log("  - Mode:", session.mode);
    console.log("[checkout/subscription] === DEBUG INFO END ===");

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("[checkout/subscription] Error creating session:", error);
    if (error instanceof Error) {
      console.error("[checkout/subscription] Error details:", {
        message: error.message,
        stack: error.stack
      });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}