import { redirect } from "next/navigation";
export default async function Page({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  const match = /^\/user\/([A-Za-z0-9_]{1,15})$/.exec(returnTo || "");
  const target = match ? `/io/${match[1]}` : "/io";
  redirect(`/io/signin?mode=login&returnTo=${encodeURIComponent(target)}`);
}
