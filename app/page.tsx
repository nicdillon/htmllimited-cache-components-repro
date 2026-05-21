import Link from "next/link";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>htmlLimitedBots + cacheComponents repro</h1>
      <p>
        The route under test is <code>/item/[id]</code>. Try{" "}
        <Link href="/item/abc123">/item/abc123</Link> and inspect where the dynamic{" "}
        <code>&lt;meta&gt;</code> tags render under different User-Agent strings.
      </p>
      <p>
        Verification commands and a full write-up are in the{" "}
        <a href="https://github.com/" target="_blank" rel="noreferrer">README</a>.
      </p>
    </main>
  );
}
