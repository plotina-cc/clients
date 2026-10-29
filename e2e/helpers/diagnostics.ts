import type { Page, Request, Response, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export interface Diagnostics {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
}

/**
 * Starts collecting the three things that explain a failed attach: the
 * browser console, uncaught page errors, and network failures. Call it before
 * navigating.
 */
export function collectDiagnostics(page: Page): Diagnostics {
  const diag: Diagnostics = {
    console: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
  };

  page.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    diag.console.push(text);
    if (diag.console.length > 400) diag.console.shift();
  });
  page.on("pageerror", (err) => {
    diag.pageErrors.push(String(err?.stack ?? err));
    if (diag.pageErrors.length > 50) diag.pageErrors.shift();
  });
  page.on("requestfailed", (req: Request) => {
    diag.failedRequests.push(
      `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`,
    );
    if (diag.failedRequests.length > 100) diag.failedRequests.shift();
  });
  page.on("response", (res: Response) => {
    if (res.status() >= 400) {
      const url = res.url();
      // Assets for other origins (homeserver, LiveKit) are noise unless they
      // fail, so every 4xx/5xx is kept but capped.
      diag.badResponses.push(`${res.status()} ${res.request().method()} ${url}`);
      if (diag.badResponses.length > 100) diag.badResponses.shift();
    }
  });

  return diag;
}

/** Snapshot of everything the wrapper exposes in the page. */
export async function readPlotinaState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __plotinaDfn?: {
        status?: string;
        level?: number;
        error?: string;
        track?: unknown;
      };
      __plotinaNoiseStats?: Record<string, unknown>;
      __e2eDfnHistory?: unknown[];
      __plotinaEc?: boolean;
    };
    const dfn = w.__plotinaDfn;
    return {
      url: location.href,
      title: document.title,
      plotinaEc: w.__plotinaEc ?? null,
      dfn: dfn
        ? {
            status: dfn.status ?? null,
            level: dfn.level ?? null,
            error: dfn.error ?? null,
            track: typeof dfn.track === "string" ? dfn.track : null,
          }
        : null,
      history: w.__e2eDfnHistory ?? [],
      stats: w.__plotinaNoiseStats ?? null,
      noiseLevelStored: (() => {
        try {
          return localStorage.getItem("plotina.noise.level");
        } catch {
          return null;
        }
      })(),
      bodyText: document.body?.innerText?.slice(0, 4000) ?? "",
    };
  });
}

/**
 * Attaches a JSON report with the page state, console and network failures,
 * and returns the same object so the caller can log a compact summary.
 */
export async function attachDiagnostics(
  page: Page,
  diag: Diagnostics,
  testInfo: TestInfo,
  label: string,
): Promise<Record<string, unknown>> {
  const state = await readPlotinaState(page).catch((e) => ({
    url: page.url(),
    readError: String(e),
  }));
  const report = {
    label,
    at: new Date().toISOString(),
    ...state,
    console: diag.console,
    pageErrors: diag.pageErrors,
    failedRequests: diag.failedRequests,
    badResponses: diag.badResponses,
  };
  const body = JSON.stringify(report, null, 2);
  await testInfo.attach(`${label}.json`, {
    body,
    contentType: "application/json",
  });
  // A copy next to the trace, so it survives even when the HTML report is
  // not downloaded.
  try {
    await writeFile(testInfo.outputPath(`${label}.json`), body, "utf8");
  } catch {
    /* the attachment above is enough */
  }
  return report;
}
