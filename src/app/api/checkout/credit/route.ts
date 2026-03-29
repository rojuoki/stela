import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

type CreditAmount = 1 | 3 | 10 | 20;

export async function POST(req: NextRequest) {
  try {
    console.log("[checkout/credit] === DEBUG INFO START ===");
    console.log("[checkout/credit] NODE_ENV:", process.env.NODE_ENV);
    
    const user = await getUserFromRequest(req);
    if (!user) {
      console.log("[checkout/credit] User not authenticated");
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    
    console.log("[checkout/credit] User:", { id: user.id, email: user.email });

    const body = await req.json();
    const { creditAmount } = body;

    console.log("[checkout/credit] Requested credit amount:", creditAmount);

    // Validate credit amount
    const validAmounts: CreditAmount[] = [1, 3, 10, 20];
    if (!validAmounts.includes(creditAmount)) {
      console.log("[checkout/credit] Invalid credit amount:", creditAmount);
      return NextResponse.json(
        { error: "Invalid credit amount. Must be 1, 3, 10, or 20" },
        { status: 400 }
      );
    }

    // Map to environment variable
    const priceEnvMap: Record<CreditAmount, string | undefined> = {
      1: process.env.STRIPE_PRICE_CREDIT_1,
      3: process.env.STRIPE_PRICE_CREDIT_3,
      10: process.env.STRIPE_PRICE_CREDIT_10,
      20: process.env.STRIPE_PRICE_CREDIT_20,
    };

    const priceId = priceEnvMap[creditAmount as CreditAmount];
    
    console.log("[checkout/credit] Price env variable:", `STRIPE_PRICE_CREDIT_${creditAmount}`);
    console.log("[checkout/credit] Price ID:", priceId || "NOT SET");

    if (!priceId) {
      console.log("[checkout/credit] Missing price configuration for credit amount:", creditAmount);
      return NextResponse.json(
        { error: `Credit package configuration missing: STRIPE_PRICE_CREDIT_${creditAmount} not set` },
        { status: 500 }
      );
    }

    console.log("[checkout/credit] Creating Stripe session...");
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // One-time payment for credits
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      metadata: {
        userId: user.id,
        type: 'credit',
        creditAmount: creditAmount.toString()
      },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/?credit=success&amount=${creditAmount}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/account/credits`,
    });

    console.log("[checkout/credit] Session created successfully:");
    console.log("  - Session ID:", session.id);
    console.log("  - Session URL:", session.url);
    console.log("  - Metadata:", session.metadata);
    console.log("  - Mode:", session.mode);
    console.log("[checkout/credit] === DEBUG INFO END ===");

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("[checkout/credit] Error creating session:", error);
    if (error instanceof Error) {
      console.error("[checkout/credit] Error details:", {
        message: error.message,
        stack: error.stack
      });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}