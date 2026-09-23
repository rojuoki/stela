import { redirect } from "next/navigation";
export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  redirect(`/io/${encodeURIComponent((await params).username)}`);
}
