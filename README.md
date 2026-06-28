# Oakridge Appointment Checker

This is a tiny checker for Oakridge Park Medical Centre's SystmConnect page.

It does **not** book an appointment. It only checks whether the "New condition"
request route looks open. If it may be open, it sends you a Telegram message.
You then open the link yourself and complete the NHS/GP request honestly.

## How It Works

1. GitHub runs this checker for free on a schedule.
2. The checker opens the Oakridge SystmConnect page.
3. It clicks "New condition".
4. If the page says it is unavailable, nothing happens.
5. If the unavailable message is gone, Telegram messages you.

The schedule is currently:

- Monday to Friday
- 6:03am to 8:58am London time
- Around every 5 minutes

GitHub scheduled jobs can sometimes run a little late, so this is not perfectly
instant, but it is good enough for checking a public page repeatedly.

## What You Need

- A GitHub account
- A Telegram account
- About 20 to 30 minutes the first time

You do not need programming knowledge.

## Step 1: Create A Telegram Bot

1. Open Telegram.
2. Search for `@BotFather`.
3. Open the real BotFather account. It should have a blue verified check.
4. Send this message:

   `/newbot`

5. BotFather will ask for a name. Example:

   `Oakridge Appointment Checker`

6. BotFather will ask for a username. It must end in `bot`. Example:

   `oakridge_checker_123_bot`

7. BotFather will give you a token. It looks roughly like this:

   `123456789:ABCdefGhijk...`

Keep that token private. Do not post it online.

## Step 2: Start Your Bot

1. Click the link BotFather gives you for your new bot.
2. Press `Start`.
3. Send it any message, like:

   `hello`

This step matters. Your bot cannot message you until you message it first.

## Step 3: Find Your Telegram Chat ID

1. Open your web browser.
2. In the address bar, paste this, but replace `YOUR_TOKEN_HERE` with your real
   BotFather token:

   `https://api.telegram.org/botYOUR_TOKEN_HERE/getUpdates`

3. Look for a part like this:

   `"chat":{"id":123456789`

4. Copy only the number. That is your `TELEGRAM_CHAT_ID`.

If you see an empty result, go back to Telegram, send your bot another `hello`,
then refresh the browser page.

## Step 4: Create A GitHub Repository

1. Go to `https://github.com/`.
2. Sign in or create an account.
3. Click the `+` button near the top right.
4. Click `New repository`.
5. Repository name:

   `oakridge-appointment-monitor`

6. Choose `Private`.
7. Click `Create repository`.

## Step 5: Upload These Files To GitHub

Upload everything in this folder to the new repository:

- `package.json`
- `scripts/check-oakridge.js`
- `.github/workflows/check-oakridge.yml`
- `README.md`

The `.github` folder is important. Do not skip it.

Beginner-friendly way:

1. On your empty GitHub repository page, click `uploading an existing file`.
2. Drag this whole folder's contents into the upload area.
3. Click `Commit changes`.

If GitHub does not upload the hidden `.github` folder from drag-and-drop, create
the workflow file manually:

1. Click `Add file`.
2. Click `Create new file`.
3. Name it exactly:

   `.github/workflows/check-oakridge.yml`

4. Paste the contents from the local `.github/workflows/check-oakridge.yml`
   file.
5. Click `Commit changes`.

## Step 6: Add Your Telegram Secrets

Never put your Telegram token inside the code files. Put it in GitHub Secrets.

1. In your GitHub repository, click `Settings`.
2. In the left menu, click `Secrets and variables`.
3. Click `Actions`.
4. Click `New repository secret`.
5. Name:

   `TELEGRAM_BOT_TOKEN`

6. Value:

   Paste your BotFather token.

7. Click `Add secret`.
8. Click `New repository secret` again.
9. Name:

   `TELEGRAM_CHAT_ID`

10. Value:

    Paste your chat ID number.

11. Click `Add secret`.

## Step 7: Test Telegram

1. In your GitHub repository, click `Actions`.
2. Click `Check Oakridge appointments`.
3. Click `Run workflow`.
4. Turn on `Send a Telegram test message only`.
5. Click the green `Run workflow` button.

Wait a minute or two. You should receive a Telegram message saying:

`Test message from the Oakridge appointment checker. Telegram is connected.`

## Step 8: Let It Run

After setup, it runs automatically Monday to Friday between 6:03am and 8:58am
London time.

When the route may be open, Telegram will send:

`Oakridge alert: New condition may be open now.`

Then open the SystmConnect link and complete the request yourself.

## Change The Request Type

By default, it checks `New condition`.

If you later want to check a different route, edit this line in
`scripts/check-oakridge.js`:

```js
const CATEGORY_LABEL = process.env.CATEGORY_LABEL || "New condition";
```

Examples from the current SystmConnect page:

- `Non-urgent medical condition`
- `New condition`
- `Existing condition`
- `Follow up`

## Safety Notes

- This checker only reads the public availability page.
- It does not log in.
- It does not enter your medical details.
- It does not submit anything.
- Do not run it every few seconds. That is unfair to the website.
- If you have urgent symptoms, do not wait for this checker. Use NHS 111 or 999
  as appropriate.
