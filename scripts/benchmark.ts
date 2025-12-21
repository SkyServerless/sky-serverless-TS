import { App } from "../src/core/app";
import { SkyContext } from "../src/core/context";
import { SkyRequest } from "../src/core/http";
import { parseBody } from "../src/core/http/parsers";

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 50000);
const ROUTES = Number(process.env.BENCH_ROUTES ?? 1000);
const PLUGINS = Number(process.env.BENCH_PLUGINS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 500);
const CACHE_ENABLED = false;

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  opsPerSec: number;
}

async function runBench(
  name: string,
  iterations: number,
  fn: (iteration: number) => void | Promise<void>,
): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i += 1) {
    await fn(i);
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    await fn(i);
  }
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  const opsPerSec = (iterations / totalMs) * 1000;

  return { name, iterations, totalMs, opsPerSec };
}

function createContext(): SkyContext {
  return {
    requestId: "bench",
    provider: "bench",
    services: {},
  };
}

function createRequest(path: string, method = "GET"): SkyRequest {
  return {
    path,
    method,
    headers: {},
  };
}

function createNoopPlugins(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `bench-${index}`,
    version: "0.0.0",
    onRequest() {},
    onResponse() {},
  }));
}

function configureRouter(app: App) {
  if (!CACHE_ENABLED) {
    app.getRouter().setMatchCacheEnabled(false);
  }
}

async function benchCoreSingleRoute(): Promise<BenchResult> {
  const app = new App();
  configureRouter(app);
  app.get("/", () => ({ statusCode: 200, body: { ok: true } }));
  const request = createRequest("/");

  return runBench("core: single route", ITERATIONS, async () => {
    await app.handle(request, createContext());
  });
}

async function benchCoreManyRoutesFirstMatch(): Promise<BenchResult> {
  const app = new App();
  configureRouter(app);
  for (let i = 0; i < ROUTES; i += 1) {
    app.get(`/route-${i}`, () => ({ statusCode: 200, body: { ok: true } }));
  }

  const request = createRequest("/route-0");

  return runBench(`core: ${ROUTES} routes (first match)`, ITERATIONS, async () => {
    await app.handle(request, createContext());
  });
}

async function benchCoreManyRoutesLastMatch(): Promise<BenchResult> {
  const app = new App();
  configureRouter(app);
  for (let i = 0; i < ROUTES; i += 1) {
    app.get(`/route-${i}`, () => ({ statusCode: 200, body: { ok: true } }));
  }

  const request = createRequest(`/route-${ROUTES - 1}`);

  return runBench(`core: ${ROUTES} routes (last match)`, ITERATIONS, async () => {
    await app.handle(request, createContext());
  });
}

async function benchCoreManyRoutesCacheMiss(): Promise<BenchResult> {
  const app = new App();
  configureRouter(app);
  for (let i = 0; i < ROUTES; i += 1) {
    app.get(`/route-${i}`, () => ({ statusCode: 200, body: { ok: true } }));
  }

  const request = createRequest("/no-match");

  return runBench(`core: ${ROUTES} routes (cache miss)`, ITERATIONS, async (i) => {
    request.path = `/no-match-${i}`;
    await app.handle(request, createContext());
  });
}

async function benchPluginOverhead(): Promise<BenchResult> {
  const app = new App({ plugins: createNoopPlugins(PLUGINS) });
  configureRouter(app);
  app.get("/", () => ({ statusCode: 200, body: { ok: true } }));
  const request = createRequest("/");

  return runBench(`plugins: ${PLUGINS} no-op hooks`, ITERATIONS, async () => {
    await app.handle(request, createContext());
  });
}

function benchParseJson(): BenchResult {
  const rawBody = JSON.stringify({ ok: true, count: 42, tags: ["a", "b"] });
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    parseBody(rawBody, "application/json");
  }
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  const opsPerSec = (ITERATIONS / totalMs) * 1000;

  return { name: "parse: json", iterations: ITERATIONS, totalMs, opsPerSec };
}

function benchParseForm(): BenchResult {
  const rawBody = "name=sky&tags=a&tags=b&count=42";
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    parseBody(rawBody, "application/x-www-form-urlencoded");
  }
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  const opsPerSec = (ITERATIONS / totalMs) * 1000;

  return { name: "parse: form", iterations: ITERATIONS, totalMs, opsPerSec };
}

function printHeader() {
  console.log("SkyServerless core benchmark");
  console.log(
    `iterations=${ITERATIONS}, warmup=${WARMUP}, routes=${ROUTES}, plugins=${PLUGINS}, cache=${CACHE_ENABLED ? "on" : "off"}`,
  );
  console.log("");
}

function printResult(result: BenchResult) {
  const ops = Math.round(result.opsPerSec).toLocaleString("en-US");
  const totalMs = result.totalMs.toFixed(2).padStart(8, " ");
  console.log(`${result.name.padEnd(32, " ")} ${totalMs} ms  ${ops} ops/s`);
}

async function main() {
  printHeader();
  const results = [
    await benchCoreSingleRoute(),
    await benchCoreManyRoutesFirstMatch(),
    await benchCoreManyRoutesLastMatch(),
    await benchCoreManyRoutesCacheMiss(),
    await benchPluginOverhead(),
    benchParseJson(),
    benchParseForm(),
  ];

  for (const result of results) {
    printResult(result);
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
