import { redirect } from "next/navigation";

/**
 * Legacy URL — single UI lives at /account/credits (packages + balance).
 */
export default function BuyUnlockRedirectPage() {
  redirect("/account/credits");
}
