import { chromium } from "playwright";

const START_URL =
  "https://systmonline.tpp-uk.com/2/OnlineConsultation?OrgId=K82032";
const CATEGORY_LABEL = process.env.CATEGORY_LABEL || "New condition";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SEND_TEST_MESSAGE =
  String(process.env.SEND_TEST_MESSAGE || "").toLowerCase() === "true";
const SEND_CLOSED_STATUS =
  String(process.env.SEND_CLOSED_STATUS || "").toLowerCase() === "true";

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
  return value.replace(/\s+/g, " ").trim();
}

function looksUnavailable(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("currently unavailable") ||
    lower.includes("not accepting online") ||
    lower.includes("we are not accepting")
  );
}

if (SEND_TEST_MESSAGE) {
  await sendTelegram(
    "Test message from the Oakridge appointment checker. Telegram is connected."
  );
  console.log("Sent Telegram test message.");
  process.exit(0);
}

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

  const checkedAt = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    dateStyle: "medium",
    timeStyle: "short"
  });

  if (looksUnavailable(pageText)) {
    console.log(`[${checkedAt}] ${CATEGORY_LABEL} is still unavailable.`);

    if (SEND_CLOSED_STATUS) {
      await sendTelegram(
        `Oakridge checked at ${checkedAt}: ${CATEGORY_LABEL} is still unavailable.`
      );
    }

    process.exit(0);
  }

  await sendTelegram(
    [
      `Oakridge alert: ${CATEGORY_LABEL} may be open now.`,
      "",
      `Checked: ${checkedAt}`,
      `Open this link and complete the request yourself:`,
      START_URL,
      "",
      "Do not ignore urgent symptoms. If it is urgent, use 111/999 as appropriate."
    ].join("\n")
  );

  console.log(`[${checkedAt}] Possible opening detected. Telegram alert sent.`);
} finally {
  await browser.close();
}
