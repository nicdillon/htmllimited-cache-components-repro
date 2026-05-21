import type { Metadata } from "next";
import { Suspense } from "react";

interface ItemPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ variant?: string }>;
}

async function fetchItem(id: string) {
  "use cache: remote";
  // Simulate per-id data fetch (DB / external API).
  await new Promise((r) => setTimeout(r, 100));
  return { id, name: `Item ${id}`, description: `Description for ${id}` };
}

export async function generateMetadata(props: ItemPageProps): Promise<Metadata> {
  // searchParams resolved outside the cache scope per the error guidance.
  const { variant } = await props.searchParams;
  return buildCachedItemMetadata(props.params, variant);
}

async function buildCachedItemMetadata(
  paramsPromise: ItemPageProps["params"],
  _variant: string | undefined,
): Promise<Metadata> {
  "use cache: remote";
  const { id } = await paramsPromise;
  const item = await fetchItem(id);
  return {
    title: `${item.name}`,
    description: item.description,
    openGraph: { title: item.name, description: item.description },
    twitter: { card: "summary", title: item.name, description: item.description },
  };
}

async function ItemBody({ paramsPromise }: { paramsPromise: ItemPageProps["params"] }) {
  const { id } = await paramsPromise;
  const item = await fetchItem(id);
  return (
    <main>
      <h1>{item.name}</h1>
      <p>{item.description}</p>
    </main>
  );
}

export default function ItemPage(props: ItemPageProps) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ItemBody paramsPromise={props.params} />
    </Suspense>
  );
}
