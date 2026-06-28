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
