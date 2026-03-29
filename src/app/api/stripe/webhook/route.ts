import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import Stripe from 'stripe';
import { createOrUpdateSubscription } from "@/lib/repository";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  console.log("\n=== 🚀 STRIPE WEBHOOK DEBUG START ===");
  console.log("[stripe/webhook] 1. Request received");
  console.log("[stripe/webhook] Request method:", req.method);
  console.log("[stripe/webhook] Request URL:", req.url);
  console.log("[stripe/webhook] Timestamp:", new Date().toISOString());
  
  const body = await req.text();
  console.log("[stripe/webhook] 2. Body parsed, length:", body.length);
  
  const headersList = await headers();
  const sig = headersList.get('stripe-signature') as string;
  console.log("[stripe/webhook] 3. Headers checked");
  console.log("[stripe/webhook] Stripe signature present:", !!sig);
  console.log("[stripe/webhook] STRIPE_WEBHOOK_SECRET set:", !!process.env.STRIPE_WEBHOOK_SECRET);
  
  if (!sig) {
    console.error("[stripe/webhook] No Stripe signature found in headers");
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  try {
    console.log("[stripe/webhook] 4. Attempting to verify webhook signature...");
    const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    
    console.log("✅ [stripe/webhook] 5. Event verified successfully!");
    console.log("[stripe/webhook] Event Type:", event.type);
    console.log("[stripe/webhook] Event ID:", event.id);
    console.log("[stripe/webhook] Event Created:", event.created);

    console.log("[stripe/webhook] 6. Entering event type switch...");
    switch (event.type) {
      case 'checkout.session.completed': {
        console.log("🎯 [stripe/webhook] 7. MATCHED checkout.session.completed!");
        
        const session = event.data.object as Stripe.Checkout.Session;
        
        console.log("[stripe/webhook] 8. Session object extracted:");
        console.log("  - Session ID:", session.id);
        console.log("  - Session mode:", session.mode);
        console.log("  - Payment status:", session.payment_status);
        console.log("  - Session status:", session.status);
        
        console.log("[stripe/webhook] 9. Checking metadata...");
        console.log("  - Raw metadata:", JSON.stringify(session.metadata));
        console.log("  - Metadata exists:", !!session.metadata);
        
        const metadata = session.metadata || {};
        const { userId, type } = metadata;
        
        console.log("[stripe/webhook] 10. Extracted from metadata:");
        console.log("  - userId:", userId);
        console.log("  - type:", type);
        
        console.log("[stripe/webhook] 11. Validating userId...");
        if (!userId) {
          console.error("❌ [stripe/webhook] FAILED: Missing userId in session metadata");
          console.error("[stripe/webhook] Available metadata:", metadata);
          return NextResponse.json({ error: "Missing userId" }, { status: 400 });
        }
        console.log("✅ [stripe/webhook] userId validation passed:", userId);

        // Handle different purchase types - extensible design
        // Default to 'subscription' if type is not specified (backward compatibility)
        const purchaseType = type || 'subscription';
        
        console.log("[stripe/webhook] 12. Determined purchase type:", purchaseType);
        console.log(`[stripe/webhook] 13. Processing ${purchaseType} for user ${userId}`);

        console.log("[stripe/webhook] 14. Entering purchase type switch...");
        switch (purchaseType) {
          case 'subscription': {
            console.log("🔄 [stripe/webhook] 15. MATCHED subscription case!");
            
            const plan = (metadata.plan as 'basic') || 'basic';
            console.log("[stripe/webhook] 16. Plan extracted:", plan);
            console.log(`[stripe/webhook] 17. About to call createOrUpdateSubscription(${userId}, ${plan}, 4)`);
            
            try {
              console.log("[stripe/webhook] 18. Calling createOrUpdateSubscription...");
              const result = createOrUpdateSubscription(userId, plan, 4);
              console.log("🎉 [stripe/webhook] 19. createOrUpdateSubscription SUCCESS!");
              console.log("[stripe/webhook] Result:", JSON.stringify(result, null, 2));
              console.log(`✅ [stripe/webhook] Subscription activated successfully for user ${userId}`);
            } catch (error) {
              console.error("💥 [stripe/webhook] 19. createOrUpdateSubscription FAILED!");
              console.error(`[stripe/webhook] Error for user ${userId}:`, error);
              if (error instanceof Error) {
                console.error("[stripe/webhook] Error message:", error.message);
                console.error("[stripe/webhook] Error stack:", error.stack);
              }
              return NextResponse.json({ error: "Failed to activate subscription" }, { status: 500 });
            }
            break;
          }
          
          // Future extension points:
          // case 'credit': {
          //   const amount = parseInt(metadata.creditAmount || '1');
          //   giveCredits(userId, amount, 'Credit package purchase');
          //   break;
          // }
          // 
          // case 'unlock': {
          //   const accountId = metadata.accountId;
          //   // Handle one-time unlock purchase
          //   break;
          // }
          
          default: {
            console.log("⚠️ [stripe/webhook] 15. UNKNOWN purchase type:", purchaseType);
            console.error(`[stripe/webhook] Unknown purchase type: ${purchaseType}. Available metadata:`, metadata);
            // Fallback to subscription for unknown types (backward compatibility)
            console.log(`[stripe/webhook] 16. Falling back to subscription processing for user ${userId}`);
            try {
              console.log("[stripe/webhook] 17. Calling createOrUpdateSubscription (fallback)...");
              const result = createOrUpdateSubscription(userId, 'basic', 4);
              console.log("✅ [stripe/webhook] 18. Subscription activated successfully (fallback)");
              console.log("[stripe/webhook] Fallback result:", JSON.stringify(result, null, 2));
            } catch (error) {
              console.error("💥 [stripe/webhook] 18. Fallback subscription activation FAILED!");
              console.error(`[stripe/webhook] Fallback error for user ${userId}:`, error);
              return NextResponse.json({ error: "Failed to activate subscription" }, { status: 500 });
            }
            break;
          }
        }
        console.log("✅ [stripe/webhook] 20. checkout.session.completed processing completed");
        break;
      }
      
      default:
        console.log(`⚠️ [stripe/webhook] 7. UNHANDLED event type: ${event.type}`);
    }

    console.log("🎉 [stripe/webhook] 21. Webhook processing completed successfully");
    console.log("=== ✅ STRIPE WEBHOOK DEBUG END ===\n");
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("\n💥 === STRIPE WEBHOOK ERROR ===");
    console.error("[stripe/webhook] ❌ Error at step 4-5 (signature verification) or later");
    console.error("[stripe/webhook] Error type:", error?.constructor?.name);
    console.error("[stripe/webhook] Error message:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("[stripe/webhook] Error stack:", error.stack);
    }
    
    // Stripe signature validation error
    if (error instanceof Error && error.message.includes('signature')) {
      console.error("[stripe/webhook] 🚨 SIGNATURE VALIDATION FAILED");
      console.error("[stripe/webhook] This indicates webhook secret mismatch or invalid request");
      console.error("[stripe/webhook] Check STRIPE_WEBHOOK_SECRET configuration");
    }
    
    console.error("=== STRIPE WEBHOOK DEBUG END ===\n");
    return NextResponse.json({ error: "Webhook error" }, { status: 400 });
  }
}