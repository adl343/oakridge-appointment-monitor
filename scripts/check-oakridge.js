import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const CATEGORY_LABEL = process.env.CATEGORY_LABEL || "New condition";
const CATEGORY_ID = process.env.CATEGORY_ID || "7";
const START_URL =
  process.env.START_URL ||
  "https://systmonline.tpp-uk.com/2/OnlineConsultation?OrgId=K82032";
const CATEGORY_URL = process.env.CATEGORY_URL || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_PATH = process.env.STATE_PATH || "data/oakridge-status.json";
const MAX_DAYS_TO_KEEP = numberEnv("MAX_DAYS_TO_KEEP", 30);
const MAX_CHECKS_PER_DAY = numberEnv("MAX_CHECKS_PER_DAY", 200);
const SLOW_THRESHOLD_MS = numberEnv("SLOW_THRESHOLD_MS", 10000);
const AVAILABLE_ALERT_COOLDOWN_MINUTES = numberEnv(
  "AVAILABLE_ALERT_COOLDOWN_MINUTES",
  5
);
const MAX_AVAILABLE_ALERTS_PER_DAY = numberEnv("MAX_AVAILABLE_ALERTS_PER_DAY", 12);
const ERROR_ALERT_COOLDOWN_MINUTES = numberEnv("ERROR_ALERT_COOLDOWN_MINUTES", 60);
const MAX_ERROR_ALERTS_PER_DAY = numberEnv("MAX_ERROR_ALERTS_PER_DAY", 3);
const SEND_TEST_MESSAGE = flagEnv("SEND_TEST_MESSAGE");
const SEND_CLOSED_STATUS = flagEnv("SEND_CLOSED_STATUS");
const SEND_STATUS_MESSAGE = flagEnv("SEND_STATUS_MESSAGE");
const ALERT_EVERY_AVAILABLE = flagEnv("ALERT_EVERY_AVAILABLE", true);
const DRY_RUN_TELEGRAM = flagEnv("DRY_RUN_TELEGRAM");
const MOCK_STATUS = process.env.MOCK_STATUS || "";
const USER_AGENT =
  "Mozilla/5.0 (compatible; OakridgeAppointmentChecker/1.0; +https://github.com/adl343/oakridge-appointment-monitor)";

function flagEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

async function sendTelegram(message) {
  if (DRY_RUN_TELEGRAM) {
    console.log(["DRY RUN TELEGRAM MESSAGE", message].join("\n"));
    return;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in GitHub secrets.");
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      disable_web_page_preview: true
    })
  });
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram did not accept the message: ${result.description || "unknown error"}`);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToText(html) {
  return cleanText(
    decodeHtml(
      String(html || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? value.split(/,(?=[^;,]+=)/) : [];
}

function cookieHeaderFrom(response) {
  return getSetCookies(response.headers)
    .map((value) => value.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function extractHeading(html) {
  const match = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? htmlToText(match[1]) : "No heading found";
}

function extractCategoryUrl(html, baseUrl) {
  if (CATEGORY_URL) {
    return CATEGORY_URL;
  }

  const anchors = String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  for (const anchor of anchors) {
    const attrs = anchor[1];
    const label = htmlToText(anchor[2]);
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&");
    if (!href) {
      continue;
    }
    if (
      label.toLowerCase().includes(CATEGORY_LABEL.toLowerCase()) ||
      href.includes(`OnConCategory=${CATEGORY_ID}`)
    ) {
      return new URL(href, baseUrl).href;
    }
  }

  throw new Error(`Could not find the "${CATEGORY_LABEL}" link on the start page.`);
}

function looksUnavailable(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("currently unavailable") ||
    lower.includes("not accepting online") ||
    lower.includes("we are not accepting")
  );
}

function looksLikeProblemPage(text, heading) {
  const lowerText = text.toLowerCase();
  const lowerHeading = String(heading || "").toLowerCase();
  return lowerHeading === "there is a problem" || lowerText.includes("there is a problem");
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

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 2, categoryLabel: CATEGORY_LABEL, days: {} };
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
    lastStatusChangedAt: "",
    lastHeading: "",
    lastError: "",
    lastDurationMs: 0,
    lastCheckedUrl: "",
    availableAlertsSent: 0,
    lastAvailableAlertAt: "",
    lastAvailableAlertAtIso: "",
    errorAlertsSent: 0,
    lastErrorAlertAt: "",
    lastErrorAlertAtIso: "",
    healthMessagesSent: 0,
    lastHealthMessageAt: "",
    lastHealthMessageAtIso: "",
    transitions: [],
    alerts: [],
    checks: []
  };
}

function ensureDayShape(day) {
  const defaults = emptyDay(day.date || "");
  for (const [key, value] of Object.entries(defaults)) {
    if (day[key] === undefined) {
      day[key] = Array.isArray(value) ? [] : value;
    }
  }
  return day;
}

function pruneOldDays(state) {
  const keys = Object.keys(state.days || {}).sort();
  const oldKeys = keys.slice(0, Math.max(0, keys.length - MAX_DAYS_TO_KEEP));
  for (const key of oldKeys) {
    delete state.days[key];
  }
}

function recordCheck(state, result) {
  state.version = 2;
  state.categoryLabel = CATEGORY_LABEL;
  state.lastUpdatedAt = result.checkedAtIso;
  state.days ||= {};

  const day = ensureDayShape(
    (state.days[result.dateKey] ||= emptyDay(result.dateKey))
  );
  const previousStatus = day.lastStatus || "";

  day.totalChecks += 1;
  day.totalDurationMs += result.durationMs;
  day.slowestMs = Math.max(day.slowestMs || 0, result.durationMs);
  day.lastDurationMs = result.durationMs;
  day.firstCheckAt ||= result.checkedAtLocal;
  day.lastCheckAt = result.checkedAtLocal;
  day.lastHeading = result.heading || "";
  day.lastError = result.error || "";
  day.lastCheckedUrl = result.checkedUrl || "";

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
    day.lastStatusChangedAt = result.checkedAtLocal;
    day.transitions.push({
      at: result.checkedAtLocal,
      iso: result.checkedAtIso,
      time: result.time,
      from: previousStatus,
      to: result.status,
      heading: result.heading || "",
      error: result.error || ""
    });
  } else if (!previousStatus) {
    day.lastStatusChangedAt = result.checkedAtLocal;
  }

  day.lastStatus = result.status;
  day.checks.push({
    at: result.checkedAtLocal,
    iso: result.checkedAtIso,
    time: result.time,
    status: result.status,
    durationMs: result.durationMs,
    heading: result.heading || "",
    error: result.error || "",
    url: result.checkedUrl || ""
  });
  day.checks = day.checks.slice(-MAX_CHECKS_PER_DAY);
  pruneOldDays(state);

  return { day, previousStatus };
}

function recordAlert(day, type, result) {
  day.alerts.push({
    type,
    at: result.checkedAtLocal,
    iso: result.checkedAtIso,
    status: result.status,
    heading: result.heading || "",
    error: result.error || ""
  });
  day.alerts = day.alerts.slice(-50);

  if (type === "available") {
    day.availableAlertsSent += 1;
    day.lastAvailableAlertAt = result.checkedAtLocal;
    day.lastAvailableAlertAtIso = result.checkedAtIso;
  } else if (type === "error") {
    day.errorAlertsSent += 1;
    day.lastErrorAlertAt = result.checkedAtLocal;
    day.lastErrorAlertAtIso = result.checkedAtIso;
  } else if (type === "health") {
    day.healthMessagesSent += 1;
    day.lastHealthMessageAt = result.checkedAtLocal;
    day.lastHealthMessageAtIso = result.checkedAtIso;
  }
}

function statusLabel(status) {
  if (status === "available") {
    return "possibly open";
  }
  if (status === "unavailable") {
    return "closed";
  }
  if (status === "error") {
    return "check failed";
  }
  return "unknown";
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function minutesSince(iso, nowIso) {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  const elapsedMs = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(elapsedMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return elapsedMs / 60000;
}

function shouldSendAvailableAlert(day, result, previousStatus) {
  if (result.status !== "available") {
    return false;
  }
  if (previousStatus !== "available") {
    return true;
  }
  if (!ALERT_EVERY_AVAILABLE) {
    return false;
  }
  if (day.availableAlertsSent >= MAX_AVAILABLE_ALERTS_PER_DAY) {
    return false;
  }
  return (
    minutesSince(day.lastAvailableAlertAtIso, result.checkedAtIso) >=
    AVAILABLE_ALERT_COOLDOWN_MINUTES
  );
}

function shouldSendErrorAlert(day, result, previousStatus) {
  if (result.status !== "error") {
    return false;
  }
  if (day.errorAlertsSent >= MAX_ERROR_ALERTS_PER_DAY) {
    return false;
  }
  if (previousStatus !== "error") {
    return true;
  }
  return (
    minutesSince(day.lastErrorAlertAtIso, result.checkedAtIso) >=
    ERROR_ALERT_COOLDOWN_MINUTES
  );
}

function buildSummaryMessage(day) {
  return [
    "Oakridge health",
    `${CATEGORY_LABEL}: ${statusLabel(day.lastStatus)}`,
    `Today: ${day.totalChecks} checks, ${day.availableChecks} open, ${day.errorChecks} failed`,
    `Last: ${day.lastCheckAt || "not checked"} (${seconds(day.lastDurationMs || 0)})`,
    `Last open: ${day.lastAvailableAt || "not seen today"}`,
    day.lastHeading ? `Page: ${day.lastHeading}` : "",
    day.lastError ? `Error: ${day.lastError}` : "",
    START_URL
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAvailableAlert(result) {
  return [
    `Oakridge: ${CATEGORY_LABEL} may be open.`,
    "Closed message not found.",
    `Checked: ${result.checkedAtLocal}`,
    result.heading ? `Page: ${result.heading}` : "",
    START_URL
  ]
    .filter(Boolean)
    .join("\n");
}

function buildErrorAlert(result) {
  return [
    "Oakridge checker problem.",
    `${CATEGORY_LABEL} check failed at ${result.checkedAtLocal}.`,
    `Error: ${result.error || "Unknown error"}`,
    START_URL
  ].join("\n");
}

function mockResult(status, startedAt) {
  const now = londonTime();
  const normalized = ["available", "unavailable", "error"].includes(status)
    ? status
    : "unavailable";
  return {
    status: normalized,
    checkedAtIso: new Date().toISOString(),
    checkedAtLocal: now.display,
    dateKey: now.dateKey,
    time: now.time,
    durationMs: Date.now() - startedAt,
    heading:
      process.env.MOCK_HEADING ||
      (normalized === "available"
        ? `${CATEGORY_LABEL} request`
        : normalized === "error"
          ? ""
          : `${CATEGORY_LABEL} is currently unavailable.`),
    error:
      normalized === "error"
        ? process.env.MOCK_ERROR || "Mock website layout error."
        : "",
    checkedUrl: START_URL
  };
}

async function checkWebsite() {
  const startedAt = Date.now();
  const now = londonTime();

  if (MOCK_STATUS) {
    return mockResult(MOCK_STATUS, startedAt);
  }

  const startResponse = await fetch(START_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": USER_AGENT }
  });

  if (!startResponse.ok) {
    throw new Error(`Start page returned HTTP ${startResponse.status}`);
  }

  const cookie = cookieHeaderFrom(startResponse);
  const startHtml = await startResponse.text();
  const checkUrl = extractCategoryUrl(startHtml, startResponse.url);
  const response = await fetch(checkUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(cookie ? { cookie } : {}),
      "user-agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Website returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const pageText = htmlToText(html);
  const heading = extractHeading(html);

  if (looksLikeProblemPage(pageText, heading)) {
    throw new Error("Website returned the SystmConnect problem page.");
  }

  return {
    status: looksUnavailable(pageText) ? "unavailable" : "available",
    checkedAtIso: new Date().toISOString(),
    checkedAtLocal: now.display,
    dateKey: now.dateKey,
    time: now.time,
    durationMs: Date.now() - startedAt,
    heading,
    error: "",
    checkedUrl: response.url
  };
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
    error: cleanText(error.message).slice(0, 500),
    checkedUrl: START_URL
  };
}

if (SEND_TEST_MESSAGE) {
  await sendTelegram("Oakridge test: Telegram is connected.");
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

if (shouldSendAvailableAlert(day, result, previousStatus)) {
  await sendTelegram(buildAvailableAlert(result));
  recordAlert(day, "available", result);
  await writeState(state);
  console.log("Possible opening detected. Telegram alert sent.");
}

if (shouldSendErrorAlert(day, result, previousStatus)) {
  await sendTelegram(buildErrorAlert(result));
  recordAlert(day, "error", result);
  await writeState(state);
  console.log("Checker problem detected. Telegram alert sent.");
}

if (SEND_STATUS_MESSAGE || SEND_CLOSED_STATUS) {
  await sendTelegram(buildSummaryMessage(day));
  recordAlert(day, "health", result);
  await writeState(state);
  console.log("Sent Telegram health summary.");
}

if (result.status === "error") {
  console.log(`Website check had an error: ${result.error}`);
} else {
  console.log(
    `[${result.checkedAtLocal}] ${CATEGORY_LABEL} is ${statusLabel(result.status)}.`
  );
}
