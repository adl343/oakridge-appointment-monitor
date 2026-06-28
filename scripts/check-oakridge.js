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
