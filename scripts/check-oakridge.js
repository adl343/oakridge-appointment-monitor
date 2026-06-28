import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";

const START_URL =
  "https://systmonline.tpp-uk.com/2/OnlineConsultation?OrgId=K82032";
const CATEGORY_LABEL = process.env.CATEGORY_LABEL || "New condition";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_PATH = process.env.STATE_PATH || "data/oakridge-status.json";
const SLOW_THRESHOLD_MS = Number(process.env.SLOW_THRESHOLD_MS || 20000);
const MAX_DAYS_TO_KEEP = Number(process.env.MAX_DAYS_TO_KEEP || 30);
const SEND_TEST_MESSAGE =
  String(process.env.SEND_TEST_MESSAGE || "").toLowerCase() === "true";
const SEND_CLOSED_STATUS =
  String(process.env.SEND_CLOSED_STATUS || "").toLowerCase() === "true";
const SEND_STATUS_MESSAGE =
  String(process.env.SEND_STATUS_MESSAGE || "").toLowerCase() === "true";

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in GitHub secrets."
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        disable_web_page_preview: true
      })
    }
  );

  const result = await response.json();
  if (!result.ok) {
    throw new Error(
      `Telegram did not accept the message: ${result.description || "unknown error"}`
    );
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksUnavailable(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("currently unavailable") ||
    lower.includes("not accepting online") ||
    lower.includes("we are not accepting")
  );
}

function londonTime(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    display: date.toLocaleString("en-GB", {
      timeZone: "Europe/London",
      dateStyle: "medium",
      timeStyle: "short"
    })
  };
}

function githubRunUrl() {
  if (
    !process.env.GITHUB_SERVER_URL ||
    !process.env.GITHUB_REPOSITORY ||
    !process.env.GITHUB_RUN_ID
  ) {
    return "";
  }

  return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, categoryLabel: CATEGORY_LABEL, days: {} };
    }

    throw error;
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function emptyDay(dateKey) {
  return {
    date: dateKey,
    totalChecks: 0,
    availableChecks: 0,
    unavailableChecks: 0,
    errorChecks: 0,
    slowChecks: 0,
    totalDurationMs: 0,
    slowestMs: 0,
    firstCheckAt: "",
    lastCheckAt: "",
    firstAvailableAt: "",
    lastAvailableAt: "",
    firstUnavailableAt: "",
    lastUnavailableAt: "",
    lastStatus: "",
    lastHeading: "",
    lastError: "",
    lastDurationMs: 0,
    transitions: [],
    checks: []
  };
}

function pruneOldDays(state) {
  const keys = Object.keys(state.days || {}).sort();
  const oldKeys = keys.slice(0, Math.max(0, keys.length - MAX_DAYS_TO_KEEP));

  for (const key of oldKeys) {
    delete state.days[key];
  }
}

function recordCheck(state, result) {
  state.version = 1;
  state.categoryLabel = CATEGORY_LABEL;
  state.lastUpdatedAt = result.checkedAtIso;
  state.days ||= {};

  const day = (state.days[result.dateKey] ||= emptyDay(result.dateKey));
  const previousStatus = day.lastStatus || "";

  day.totalChecks += 1;
  day.totalDurationMs += result.durationMs;
  day.slowestMs = Math.max(day.slowestMs || 0, result.durationMs);
  day.lastDurationMs = result.durationMs;
  day.firstCheckAt ||= result.checkedAtLocal;
  day.lastCheckAt = result.checkedAtLocal;
  day.lastHeading = result.heading || "";
  day.lastError = result.error || "";

  if (result.durationMs >= SLOW_THRESHOLD_MS) {
    day.slowChecks += 1;
  }

  if (result.status === "available") {
    day.availableChecks += 1;
    day.firstAvailableAt ||= result.checkedAtLocal;
    day.lastAvailableAt = result.checkedAtLocal;
  } else if (result.status === "unavailable") {
    day.unavailableChecks += 1;
    day.firstUnavailableAt ||= result.checkedAtLocal;
    day.lastUnavailableAt = result.checkedAtLocal;
  } else {
    day.errorChecks += 1;
  }

  if (previousStatus && previousStatus !== result.status) {
    day.transitions.push({
      at: result.checkedAtLocal,
      time: result.time,
      from: previousStatus,
      to: result.status,
      heading: result.heading || "",
      error: result.error || ""
    });
  }

  day.lastStatus = result.status;
  day.checks.push({
    at: result.checkedAtLocal,
    time: result.time,
    status: result.status,
    durationMs: result.durationMs,
    heading: result.heading || "",
    error: result.error || ""
  });
  day.checks = day.checks.slice(-80);

  pruneOldDays(state);

  return { day, previousStatus };
}

function statusLabel(status) {
  if (status === "available") {
    return "possible available";
  }

  if (status === "unavailable") {
    return "unavailable";
  }

  if (status === "error") {
    return "website/check error";
  }

  return "unknown";
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function loadHealth(day) {
  if (day.errorChecks === 0 && day.slowChecks === 0) {
    return "Good. No failed or unusually slow checks were recorded today.";
  }

  return `Needs attention. Failed checks: ${day.errorChecks}. Slow checks over ${seconds(
    SLOW_THRESHOLD_MS
  )}: ${day.slowChecks}.`;
}

function transitionLines(day) {
  if (!day.transitions.length) {
    return ["Changes seen: none today"];
  }

  return [
    "Changes seen:",
    ...day.transitions.slice(-8).map((change) => {
      return `- ${change.time}: ${statusLabel(change.from)} -> ${statusLabel(
        change.to
      )}`;
    })
  ];
}

function buildSummaryMessage(day) {
  const averageMs = day.totalChecks
    ? Math.round(day.totalDurationMs / day.totalChecks)
    : 0;

  return [
    "Oakridge daily pattern summary",
    "",
    `Route: ${CATEGORY_LABEL}`,
    `Latest status: ${statusLabel(day.lastStatus)}`,
    `Checks today: ${day.totalChecks}`,
    `Unavailable checks: ${day.unavailableChecks}`,
    `Possible available checks: ${day.availableChecks}`,
    `Website/link errors: ${day.errorChecks}`,
    `Slow checks: ${day.slowChecks}`,
    "",
    `First unavailable: ${day.firstUnavailableAt || "not seen today"}`,
    `Last unavailable: ${day.lastUnavailableAt || "not seen today"}`,
    `First possible available: ${day.firstAvailableAt || "not seen today"}`,
    `Last possible available: ${day.lastAvailableAt || "not seen today"}`,
    "",
    ...transitionLines(day),
    "",
    `Average check time: ${seconds(averageMs)}`,
    `Slowest check time: ${seconds(day.slowestMs || 0)}`,
    `Load health: ${loadHealth(day)}`,
    `Last page heading: ${day.lastHeading || "none"}`,
    day.lastError ? `Last error: ${day.lastError}` : "",
    "",
    "Meaning: this is only availability tracking. Please complete any medical request yourself.",
    `Open manually: ${START_URL}`,
    githubRunUrl() ? `GitHub run: ${githubRunUrl()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAvailableAlert(result, previousStatus) {
  const firstSeenText = previousStatus === "available" ? "Still possible open" : "New possible opening";

  return [
    `Oakridge alert: ${CATEGORY_LABEL} may be open now.`,
    "",
    `Type: ${firstSeenText}`,
    "Status: the usual unavailable message was not found.",
    `Checked: ${result.checkedAtLocal}`,
    `Page heading: ${result.heading || "none"}`,
    `Check time: ${seconds(result.durationMs)}`,
    "",
    "Open this link and complete the request yourself:",
    START_URL,
    "",
    "Do not ignore urgent symptoms. If it is urgent, use 111/999 as appropriate.",
    githubRunUrl() ? `GitHub run: ${githubRunUrl()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function checkWebsite() {
  const startedAt = Date.now();
  const now = londonTime();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const categoryLink = page
      .locator("a")
      .filter({ hasText: CATEGORY_LABEL })
      .first();

    await categoryLink.waitFor({ state: "visible", timeout: 15000 });

    await Promise.all([
      page.waitForURL(/OnConCategory=/, { timeout: 15000 }).catch(() => null),
      categoryLink.click()
    ]);

    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(
      () => null
    );

    const pageText = cleanText(
      await page
        .locator("main")
        .innerText({ timeout: 15000 })
        .catch(() => page.locator("body").innerText({ timeout: 15000 }))
    );
    const heading = cleanText(
      await page
        .locator("h1")
        .first()
        .innerText({ timeout: 5000 })
        .catch(() => "No heading found")
    );

    return {
      status: looksUnavailable(pageText) ? "unavailable" : "available",
      checkedAtIso: new Date().toISOString(),
      checkedAtLocal: now.display,
      dateKey: now.dateKey,
      time: now.time,
      durationMs: Date.now() - startedAt,
      heading,
      error: ""
    };
  } finally {
    await browser.close();
  }
}

function errorResult(error, startedAt) {
  const now = londonTime();

  return {
    status: "error",
    checkedAtIso: new Date().toISOString(),
    checkedAtLocal: now.display,
    dateKey: now.dateKey,
    time: now.time,
    durationMs: Date.now() - startedAt,
    heading: "",
    error: cleanText(error.message).slice(0, 500)
  };
}

if (SEND_TEST_MESSAGE) {
  await sendTelegram(
    "Test message from the Oakridge appointment checker. Telegram is connected."
  );
  console.log("Sent Telegram test message.");
  process.exit(0);
}

const runStartedAt = Date.now();
let result;

try {
  result = await checkWebsite();
} catch (error) {
  result = errorResult(error, runStartedAt);
}

const state = await readState();
const { day, previousStatus } = recordCheck(state, result);
await writeState(state);

if (SEND_STATUS_MESSAGE || SEND_CLOSED_STATUS) {
  await sendTelegram(buildSummaryMessage(day));
  console.log("Sent Telegram pattern summary.");
  process.exit(0);
}

if (result.status === "available") {
  if (previousStatus !== "available") {
    await sendTelegram(buildAvailableAlert(result, previousStatus));
    console.log("Possible opening detected. Telegram alert sent.");
  } else {
    console.log("Possible opening still visible. Alert already sent earlier.");
  }

  process.exit(0);
}

if (result.status === "error") {
  console.log(`Website check had an error: ${result.error}`);
  process.exit(0);
}

console.log(
  `[${result.checkedAtLocal}] ${CATEGORY_LABEL} is still unavailable.`
);
