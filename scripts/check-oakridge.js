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
const LOG_PATH = process.env.LOG_PATH || "data/oakridge-check-log.jsonl";
const PATTERN_PATH = process.env.PATTERN_PATH || "data/oakridge-pattern.json";
const MAX_DAYS_TO_KEEP = numberEnv("MAX_DAYS_TO_KEEP", 30);
const MAX_CHECKS_PER_DAY = numberEnv("MAX_CHECKS_PER_DAY", 200);
const MAX_LOG_LINES = numberEnv("MAX_LOG_LINES", 1500);
const SLOW_THRESHOLD_MS = numberEnv("SLOW_THRESHOLD_MS", 10000);
const HTTP_TIMEOUT_MS = numberEnv("HTTP_TIMEOUT_MS", 20000);
const MAX_REDIRECTS = numberEnv("MAX_REDIRECTS", 5);
const PAGE_TEXT_SNIPPET_LENGTH = numberEnv("PAGE_TEXT_SNIPPET_LENGTH", 280);
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
  "Mozilla/5.0 (compatible; OakridgeAppointmentChecker/1.1; +https://github.com/adl343/oakridge-appointment-monitor)";

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

function pageSnippet(text) {
  return cleanText(text).slice(0, PAGE_TEXT_SNIPPET_LENGTH);
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? value.split(/,(?=[^;,]+=)/) : [];
}

function createCookieJar() {
  return new Map();
}

function updateCookieJar(jar, headers) {
  for (const value of getSetCookies(headers)) {
    const cookie = value.split(";")[0];
    const separator = cookie.indexOf("=");
    if (separator > 0) {
      jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
    }
  }
}

function cookieHeaderFromJar(jar) {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function cookieNamesFromJar(jar) {
  return Array.from(jar.keys());
}

function extractHeading(html) {
  const match = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? htmlToText(match[1]) : "No heading found";
}

function extractTitle(html) {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]) : "";
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

function looksLikeProblemPage(text, heading, title = "") {
  const lowerText = text.toLowerCase();
  const lowerHeading = String(heading || "").toLowerCase();
  const lowerTitle = String(title || "").toLowerCase();
  return (
    lowerHeading === "there is a problem" ||
    lowerTitle.includes("there is a problem") ||
    lowerText.includes("there is a problem")
  );
}

function looksLikeInvalidSessionPage(text, heading, title = "") {
  const lowerText = text.toLowerCase();
  const lowerHeading = String(heading || "").toLowerCase();
  const lowerTitle = String(title || "").toLowerCase();
  return (
    lowerHeading.includes("invalid session") ||
    lowerTitle.includes("invalid session") ||
    lowerText.includes("invalid session") ||
    lowerText.includes("session has expired")
  );
}

function looksLikeOpenQuestionnairePage(url, heading, text, title = "") {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerHeading = String(heading || "").toLowerCase();
  const lowerText = text.toLowerCase();
  const lowerTitle = String(title || "").toLowerCase();
  return (
    lowerUrl.includes("onlineconsultationselectquestionnaire") &&
    (lowerHeading === CATEGORY_LABEL.toLowerCase() ||
      lowerTitle.includes("select questionnaire")) &&
    lowerText.includes("please fill this in if you require help with a new health problem")
  );
}

function createCheckError(message, details = {}) {
  return Object.assign(new Error(message), details);
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
      return { version: 3, categoryLabel: CATEGORY_LABEL, days: {} };
    }
    throw error;
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function weekdayName(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) {
    return "Unknown";
  }
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long"
  });
}

function timeToMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  const hours = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.round(value % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}`;
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildPattern(state) {
  const days = Object.values(state.days || {})
    .map((day) => ensureDayShape(day))
    .sort((left, right) => left.date.localeCompare(right.date));
  const weekdays = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday"
  ];

  const recentOpenings = days
    .map((day) => {
      const openChecks = day.checks.filter((check) => check.status === "available");
      if (!openChecks.length) {
        return null;
      }
      return {
        date: day.date,
        weekday: weekdayName(day.date),
        firstOpen: openChecks[0].time || "",
        lastOpen: openChecks[openChecks.length - 1].time || "",
        openChecks: openChecks.length,
        lastStatus: day.lastStatus || "",
        lastHeading: day.lastHeading || ""
      };
    })
    .filter(Boolean)
    .slice(-14)
    .reverse();

  const byWeekday = weekdays.map((weekday) => {
    const weekdayDays = days.filter((day) => weekdayName(day.date) === weekday);
    const openingDays = weekdayDays
      .map((day) => {
        const openChecks = day.checks.filter((check) => check.status === "available");
        if (!openChecks.length) {
          return null;
        }
        return {
          firstOpen: openChecks[0].time || "",
          lastOpen: openChecks[openChecks.length - 1].time || "",
          openChecks: openChecks.length
        };
      })
      .filter(Boolean);

    const firstOpenMinutes = openingDays
      .map((day) => timeToMinutes(day.firstOpen))
      .filter(Number.isFinite);
    const lastOpenMinutes = openingDays
      .map((day) => timeToMinutes(day.lastOpen))
      .filter(Number.isFinite);
    const hourCounts = new Map();

    for (const day of openingDays) {
      const hour = String(day.firstOpen || "").slice(0, 2);
      if (hour) {
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      }
    }

    const commonHours = Array.from(hourCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([hour, count]) => ({
        hour: `${hour}:00`,
        seen: count
      }));

    return {
      weekday,
      daysSeen: weekdayDays.length,
      daysOpen: openingDays.length,
      openRate: weekdayDays.length
        ? Number((openingDays.length / weekdayDays.length).toFixed(2))
        : 0,
      openChecks: openingDays.reduce((sum, day) => sum + day.openChecks, 0),
      typicalFirstOpen: minutesToTime(average(firstOpenMinutes)),
      typicalLastOpen: minutesToTime(average(lastOpenMinutes)),
      commonOpeningHours: commonHours
    };
  });

  const summaryLines = recentOpenings.length
    ? recentOpenings.map(
        (opening) =>
          `${opening.weekday} ${opening.date}: ${opening.firstOpen}${
            opening.lastOpen && opening.lastOpen !== opening.firstOpen
              ? `-${opening.lastOpen}`
              : ""
          } (${opening.openChecks} open checks)`
      )
    : ["No openings recorded yet."];

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days.length,
    openDays: recentOpenings.length,
    recentOpenings,
    byWeekday,
    summaryLines
  };
}

async function writePattern(state) {
  await mkdir(dirname(PATTERN_PATH), { recursive: true });
  await writeFile(PATTERN_PATH, `${JSON.stringify(buildPattern(state), null, 2)}\n`);
}

async function writeStateArtifacts(state) {
  await writeState(state);
  await writePattern(state);
}

async function appendLogEntry(entry) {
  let lines = [];
  try {
    lines = (await readFile(LOG_PATH, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  lines.push(JSON.stringify(entry));
  lines = lines.slice(-MAX_LOG_LINES);

  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, `${lines.join("\n")}\n`);
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
    lastPageTitle: "",
    lastSnippet: "",
    lastClassification: "",
    lastError: "",
    lastDurationMs: 0,
    lastCheckedUrl: "",
    lastTrace: [],
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
  state.version = 3;
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
  day.lastPageTitle = result.pageTitle || "";
  day.lastSnippet = result.pageTextSnippet || "";
  day.lastClassification = result.classification || "";
  day.lastError = result.error || "";
  day.lastCheckedUrl = result.checkedUrl || "";
  day.lastTrace = Array.isArray(result.trace) ? result.trace : [];

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
      classification: result.classification || "",
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
    classification: result.classification || "",
    durationMs: result.durationMs,
    heading: result.heading || "",
    title: result.pageTitle || "",
    snippet: result.pageTextSnippet || "",
    error: result.error || "",
    url: result.checkedUrl || "",
    trace: Array.isArray(result.trace) ? result.trace : []
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
    classification: result.classification || "",
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
    return "open";
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
    "Oakridge update",
    `${CATEGORY_LABEL}: ${statusLabel(day.lastStatus)}`,
    `Checks today: ${day.totalChecks}`,
    `Open today: ${day.availableChecks}`,
    `Last check: ${day.lastCheckAt || "not checked"}`,
    day.lastError ? `Issue: ${day.lastError}` : "",
    START_URL
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAvailableAlert(result) {
  return [
    "Oakridge open",
    `${CATEGORY_LABEL} form is live`,
    `Checked: ${result.checkedAtLocal}`,
    result.checkedUrl || START_URL
  ]
    .filter(Boolean)
    .join("\n");
}

function buildErrorAlert(result) {
  return [
    "Oakridge checker problem",
    `Checked: ${result.checkedAtLocal}`,
    result.error || "Unknown error",
    result.checkedUrl || START_URL
  ]
    .filter(Boolean)
    .join("\n");
}

function mockResult(status, startedAt) {
  const now = londonTime();
  const normalized = ["available", "unavailable", "error"].includes(status)
    ? status
    : "unavailable";
  return {
    status: normalized,
    classification:
      normalized === "available"
        ? "mock-open-page"
        : normalized === "error"
          ? "mock-error"
          : "mock-closed-page",
    checkedAtIso: new Date().toISOString(),
    checkedAtLocal: now.display,
    dateKey: now.dateKey,
    time: now.time,
    durationMs: Date.now() - startedAt,
    heading:
      process.env.MOCK_HEADING ||
      (normalized === "available"
        ? CATEGORY_LABEL
        : normalized === "error"
          ? ""
          : `${CATEGORY_LABEL} is currently unavailable.`),
    pageTitle:
      normalized === "available"
        ? "Select Questionnaire"
        : normalized === "error"
          ? ""
          : "Start Online Consultation",
    pageTextSnippet:
      normalized === "available"
        ? "Select Questionnaire ..."
        : normalized === "error"
          ? ""
          : `${CATEGORY_LABEL} is currently unavailable.`,
    error:
      normalized === "error"
        ? process.env.MOCK_ERROR || "Mock website layout error."
        : "",
    checkedUrl:
      normalized === "available"
        ? "https://systmonline.tpp-uk.com/2/OnlineConsultationSelectQuestionnaire"
        : START_URL,
    trace: [
      {
        step: 1,
        url: START_URL,
        responseUrl: START_URL,
        status: 200,
        location: "",
        cookieNames: ["JSESSIONID"]
      }
    ]
  };
}

async function fetchWithSession(url, jar, trace, redirectCount = 0) {
  const cookie = cookieHeaderFromJar(jar);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      ...(cookie ? { cookie } : {}),
      "user-agent": USER_AGENT
    }
  });

  updateCookieJar(jar, response.headers);

  const locationHeader = response.headers.get("location");
  const nextUrl = locationHeader ? new URL(locationHeader, response.url).href : "";
  trace.push({
    step: trace.length + 1,
    url,
    responseUrl: response.url,
    status: response.status,
    location: nextUrl,
    cookieNames: cookieNamesFromJar(jar)
  });

  if (response.status >= 300 && response.status < 400) {
    if (!nextUrl) {
      throw createCheckError("Website redirected without a location header.", {
        checkedUrl: response.url,
        trace,
        classification: "redirect-without-location"
      });
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw createCheckError("Website redirected too many times.", {
        checkedUrl: nextUrl,
        trace,
        classification: "too-many-redirects"
      });
    }
    return fetchWithSession(nextUrl, jar, trace, redirectCount + 1);
  }

  return response;
}

async function checkWebsite() {
  const startedAt = Date.now();
  const now = londonTime();

  if (MOCK_STATUS) {
    return mockResult(MOCK_STATUS, startedAt);
  }

  const trace = [];
  const jar = createCookieJar();
  const startResponse = await fetchWithSession(START_URL, jar, trace);

  if (!startResponse.ok) {
    throw createCheckError(`Start page returned HTTP ${startResponse.status}`, {
      checkedUrl: startResponse.url,
      trace,
      classification: "start-page-http-error"
    });
  }

  const startHtml = await startResponse.text();
  const checkUrl = extractCategoryUrl(startHtml, startResponse.url);
  const response = await fetchWithSession(checkUrl, jar, trace);

  if (!response.ok) {
    throw createCheckError(`Website returned HTTP ${response.status}`, {
      checkedUrl: response.url,
      trace,
      classification: "final-page-http-error"
    });
  }

  const html = await response.text();
  const pageText = htmlToText(html);
  const snippet = pageSnippet(pageText);
  const heading = extractHeading(html);
  const pageTitle = extractTitle(html);
  const checkedUrl = response.url;

  if (looksUnavailable(pageText)) {
    return {
      status: "unavailable",
      classification: "closed-message-detected",
      checkedAtIso: new Date().toISOString(),
      checkedAtLocal: now.display,
      dateKey: now.dateKey,
      time: now.time,
      durationMs: Date.now() - startedAt,
      heading,
      pageTitle,
      pageTextSnippet: snippet,
      error: "",
      checkedUrl,
      trace
    };
  }

  if (looksLikeProblemPage(pageText, heading, pageTitle)) {
    throw createCheckError("Website returned the SystmConnect problem page.", {
      heading,
      pageTitle,
      pageTextSnippet: snippet,
      checkedUrl,
      trace,
      classification: "problem-page"
    });
  }

  if (looksLikeInvalidSessionPage(pageText, heading, pageTitle)) {
    throw createCheckError("Website returned an invalid session page.", {
      heading,
      pageTitle,
      pageTextSnippet: snippet,
      checkedUrl,
      trace,
      classification: "invalid-session-page"
    });
  }

  if (looksLikeOpenQuestionnairePage(checkedUrl, heading, pageText, pageTitle)) {
    return {
      status: "available",
      classification: "questionnaire-open",
      checkedAtIso: new Date().toISOString(),
      checkedAtLocal: now.display,
      dateKey: now.dateKey,
      time: now.time,
      durationMs: Date.now() - startedAt,
      heading,
      pageTitle,
      pageTextSnippet: snippet,
      error: "",
      checkedUrl,
      trace
    };
  }

  throw createCheckError("Website returned an unrecognised page.", {
    heading,
    pageTitle,
    pageTextSnippet: snippet,
    checkedUrl,
    trace,
    classification: "unrecognised-page"
  });
}

function errorResult(error, startedAt) {
  const now = londonTime();
  return {
    status: "error",
    classification: error.classification || "runtime-error",
    checkedAtIso: new Date().toISOString(),
    checkedAtLocal: now.display,
    dateKey: now.dateKey,
    time: now.time,
    durationMs: Date.now() - startedAt,
    heading: error.heading || "",
    pageTitle: error.pageTitle || "",
    pageTextSnippet: error.pageTextSnippet || "",
    error: cleanText(error.message).slice(0, 500),
    checkedUrl: error.checkedUrl || START_URL,
    trace: Array.isArray(error.trace) ? error.trace : []
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
await writeStateArtifacts(state);

const notifications = [];
let notificationError = null;

try {
  if (shouldSendAvailableAlert(day, result, previousStatus)) {
    await sendTelegram(buildAvailableAlert(result));
    recordAlert(day, "available", result);
    notifications.push("available");
    await writeStateArtifacts(state);
    console.log("Opening detected. Telegram alert sent.");
  }

  if (shouldSendErrorAlert(day, result, previousStatus)) {
    await sendTelegram(buildErrorAlert(result));
    recordAlert(day, "error", result);
    notifications.push("error");
    await writeStateArtifacts(state);
    console.log("Checker problem detected. Telegram alert sent.");
  }

  if (SEND_STATUS_MESSAGE || SEND_CLOSED_STATUS) {
    await sendTelegram(buildSummaryMessage(day));
    recordAlert(day, "health", result);
    notifications.push("health");
    await writeStateArtifacts(state);
    console.log("Sent Telegram summary.");
  }
} catch (error) {
  notificationError = error;
}

await appendLogEntry({
  checkedAtIso: result.checkedAtIso,
  checkedAtLocal: result.checkedAtLocal,
  status: result.status,
  classification: result.classification || "",
  previousStatus,
  notifications,
  heading: result.heading || "",
  pageTitle: result.pageTitle || "",
  pageTextSnippet: result.pageTextSnippet || "",
  error: result.error || "",
  notificationError: notificationError ? cleanText(notificationError.message) : "",
  checkedUrl: result.checkedUrl || "",
  durationMs: result.durationMs,
  trace: Array.isArray(result.trace) ? result.trace : []
});

if (notificationError) {
  throw notificationError;
}

if (result.status === "error") {
  console.log(
    `Website check failed: ${result.error} (${result.classification || "runtime-error"}).`
  );
} else {
  console.log(
    `[${result.checkedAtLocal}] ${CATEGORY_LABEL} is ${statusLabel(result.status)} (${result.classification}).`
  );
}
