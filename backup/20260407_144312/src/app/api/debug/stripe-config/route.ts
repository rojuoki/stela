import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const config = {
    NODE_ENV: process.env.NODE_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? `Set (${process.env.STRIPE_SECRET_KEY.substring(0, 12)}...)` : "NOT SET",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? `Set (${process.env.STRIPE_WEBHOOK_SECRET.substring(0, 12)}...)` : "NOT SET",
    STRIPE_PRICE_BASIC: process.env.STRIPE_PRICE_BASIC || "NOT SET",
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || "NOT SET",
    
    // Validation
    validations: {
      stripe_secret_valid: process.env.STRIPE_SECRET_KEY?.startsWith('sk_') || false,
      webhook_secret_valid: process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_') || false,
      price_id_valid: process.env.STRIPE_PRICE_BASIC?.startsWith('price_') || false,
      base_url_valid: !!process.env.NEXT_PUBLIC_BASE_URL,
    }
  };

  return NextResponse.json(config, { status: 200 });
}