// Scaffold. Day 3 builds the Recovery Room: animated case-flow lanes, a live case pane that
// streams the agent's reasoning token-by-token, the "waiting on you" rail, the scoreboard.
// See context/PROJECT.md and the reference screenshots in context/reference/.

export function App() {
  return (
    <main style={{ padding: "var(--space-2xl, 48px)", fontFamily: "var(--font-prose, system-ui)" }}>
      <h1>Recovery Room</h1>
      <p style={{ color: "var(--text-muted, #666)" }}>
        Scaffold. The live agent view lands on Day 3 — see <code>context/PROJECT.md</code>.
      </p>
    </main>
  );
}
