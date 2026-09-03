import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The dependency rule is documented in CLAUDE.md and the README. Documented rules rot; this one
// is executed instead. Same instinct as the append-only test, which proves the audit guarantee by
// connecting as the app role and expecting the database to refuse.
//
//   api / worker / bench  ->  agent · safety · execution · persistence  ->  domain
//
// Arrows point down. Nothing points up, and nothing below the orchestration tier knows what
// database, queue or HTTP client is in use.

const SRC = new URL("../src", import.meta.url).pathname;

const ORCHESTRATION = ["api", "worker"];
const ADAPTERS = ["agent", "safety", "execution", "persistence"];
const INFRASTRUCTURE = ["pg", "bullmq", "ioredis", "fastify"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Every module specifier this file imports from, `import` and `export ... from` alike. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** Which top-level src/ folder a relative specifier resolves into, or null for a sibling. */
function targetLayer(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = join(fromFile, "..", specifier);
  const rel = resolved.slice(SRC.length + 1);
  const segments = rel.split("/");
  return segments.length > 1 ? segments[0]! : null;
}

function layerOf(file: string): string {
  const rel = file.slice(SRC.length + 1);
  const segments = rel.split("/");
  return segments.length > 1 ? segments[0]! : "root";
}

const FILES = sourceFiles(SRC);

describe("architecture — the dependency rule is enforced, not just documented", () => {
  it("finds the source tree it is supposed to be checking", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("domain/ depends on nothing but zod and itself", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => layerOf(f) === "domain")) {
      for (const spec of importsOf(file)) {
        const external = !spec.startsWith(".");
        if (external && spec !== "zod") offenders.push(`${layerOf(file)}: ${file} -> ${spec}`);
        const layer = targetLayer(file, spec);
        if (layer && layer !== "domain") offenders.push(`${file} -> ${layer}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("safety/ is pure policy — domain only, no I/O library at all", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => layerOf(f) === "safety")) {
      for (const spec of importsOf(file)) {
        const layer = targetLayer(file, spec);
        if (!spec.startsWith(".") || (layer && layer !== "domain")) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no adapter imports upward into an orchestration layer", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => ADAPTERS.includes(layerOf(f)))) {
      for (const spec of importsOf(file)) {
        const layer = targetLayer(file, spec);
        if (layer && ORCHESTRATION.includes(layer)) offenders.push(`${layerOf(file)}/ -> ${layer}/  (${file})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the database, the queue and the web framework out of domain/ and safety/", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => ["domain", "safety"].includes(layerOf(f)))) {
      for (const spec of importsOf(file)) {
        if (INFRASTRUCTURE.includes(spec)) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Postgres in persistence/ and the queue in the orchestration tier", () => {
    // api/ and worker/ are peers at the top tier and may hold infrastructure types; the adapter
    // layers below them may not — they talk to ports.
    const mayHoldQueue = [...ORCHESTRATION, "root"];
    const offenders: string[] = [];
    for (const file of FILES) {
      const layer = layerOf(file);
      for (const spec of importsOf(file)) {
        if (spec === "pg" && layer !== "persistence") offenders.push(`${file} -> pg`);
        if ((spec === "bullmq" || spec === "ioredis") && !mayHoldQueue.includes(layer)) {
          offenders.push(`${layer}/ -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
