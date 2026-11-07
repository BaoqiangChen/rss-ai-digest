# RSS AI Digest (Thunderbird add-on)

Reads your RSS feeds (and, optionally, newsletter folders), has an AI model — **DeepSeek** by default,
or **Claude** — pick and summarise what matters for each of your **topics**, and emails the digest
from your own Thunderbird account.

## Install

1. Thunderbird 128 or newer.
2. **Tools ▸ Add-ons and Themes** → gear icon → **Install Add-on From File…** → choose `rss-ai-digest-1.3.0.xpi`.
   (Upgrading? Install over the old version — same add-on ID, your topics and settings are kept.)
   For development: **Tools ▸ Developer Tools ▸ Debug Add-ons ▸ Load Temporary Add-on…** and pick `manifest.json`.
3. A **Digest** button appears in the main toolbar. Click it ▸ **⚙ Settings**.

## Set up (once)

1. **Connect your AI model**
   - Provider **DeepSeek**: create a key at <https://platform.deepseek.com/api_keys> and top up your balance there
     (DeepSeek is prepaid). Paste the key, click **Connect** — the model list is loaded from your account.
     `deepseek-flash` with thinking effort *Low* is a good default; *Off* is fastest/cheapest,
     `deepseek-v4-pro` is the stronger model.
   - Provider **Claude**: key from <https://platform.claude.com/settings/keys> (Claude Pro/Max chat
     subscriptions can't be used by add-ons).
   - Each provider keeps its own key and model, so you can switch back and forth.
2. **Sending**: pick the identity the digest is sent from. It uses that account's normal SMTP
   server and saved login — no extra passwords.
   **Send silently** (on by default) sends in the background with no compose window, using
   Thunderbird's `messages.sendMessage` API (Thunderbird 153 or newer). Click **Allow** once —
   Thunderbird asks whether the add-on may send messages on your behalf. On older Thunderbird
   versions, or if you don't allow it, a compose window opens minimised and closes by itself.
3. If you'll paste feed URLs, click **Allow** for website access. Feeds already in Thunderbird's
   Feeds account don't need this.

## Topics = your custom summary themes

Each topic is its own digest. Create one from scratch or from a template, then set:

| Field | What it does |
|---|---|
| I'm interested in / Not interested in | Plain-language description the AI uses to score relevance (0–5). This is the main knob. |
| Sections | Optional headings to group stories (e.g. `Research, Clinical & regulatory, Industry`). |
| Pre-filter keywords | Optional: only articles containing one of these words are sent to the AI (saves tokens). |
| Sources | Tick Thunderbird feed folders (any mail folder works too, e.g. newsletters) and/or paste feed URLs (one per line, or separated by commas/spaces). |
| Coverage | **Every feed** – one section per feed with its top *N* stories (ranked by your interests, nothing dropped; a feed the AI skips is still listed by title). **Only matching stories** – the AI keeps just the stories at or above *Minimum relevance*, grouped by theme. |
| Look back / Skip already sent | Time window (default 48 h), plus memory so the same article never appears twice. Day-only feed dates (e.g. nature.com) count for the whole day. |
| Style / Language / Min relevance | Brief, standard, detailed or executive; any language (e.g. `Simplified Chinese (中文)`); how strict to be. |
| Email | From, To (empty = yourself), subject template (`{topic}`, `{date}`, `{count}`), review-before-send, plain text. |
| Schedule | Manual, chosen days at a time, or every N hours. Runs while Thunderbird is open; a run missed in the last 12 h is caught up after start-up. |

Use **Preview** first: it builds the digest and opens it in a compose window without sending
(and without marking articles as already used).

## How it works

1. Collects items from the selected folders (`messages.query` with a date filter) and feed URLs (RSS 2.0, RSS 1.0/RDF, Atom).
2. Dedupes by link/title, drops items already included in an earlier digest, applies the keyword pre-filter, then takes a
   fair share from every feed (round-robin, newest first) up to *Max articles*, so one busy feed can't crowd out the rest.
   Feeds are downloaded 3 at a time with retries for rate-limited (429) or busy servers.
3. Sends them to the chosen model with your topic profile and asks for JSON
   (takeaways, sections, per-story headline/summary/why-it-matters, duplicates merged).
   - DeepSeek: `POST https://api.deepseek.com/chat/completions` with `response_format: json_object`,
     `thinking` / `reasoning_effort`; blank answers and overload errors are retried.
   - Claude: Messages API with structured outputs (`output_config.format`).
4. Validates the answer against the real article list (links always come from the feed, never from the model),
   renders an HTML email (with a plain-text alternative) and sends it with `messages.sendMessage`
   (silent, Thunderbird 153+) or `compose.beginNew` + `compose.sendMessage` (minimised compose window).

## Privacy

- API keys and settings are stored in Thunderbird's local extension storage (your profile, not encrypted).
- Article titles and text (up to *Max characters per article*) are sent to the chosen provider (DeepSeek or Anthropic) to make the summary.
  Check that this fits your organisation's data rules, especially for newsletters or internal mail folders.
- Nothing else leaves your machine; email goes out through your own account.

## Troubleshooting

- **401** – wrong or revoked API key. **402 (DeepSeek)** – balance is empty, top up on platform.deepseek.com.
- **"…cut off (max output tokens)"** – raise *Max output tokens* or lower *Max articles*.
- **"returned an empty answer"** – DeepSeek JSON mode occasionally does this; run again or change thinking effort.
- **Feed URL errors / NetworkError** – click **Allow** under *Website access for feed URLs*.
- **Only one or two stories** – in *Only matching stories* mode the AI drops everything below *Minimum relevance*.
  Switch *Coverage* to *Every feed*, or lower *Minimum relevance*. The email footer and the topic status show how many
  articles were read from each feed and which feeds failed.
- **A compose window still appears** – check *Send silently* under Sending: it shows whether your Thunderbird
  supports it and whether the permission was granted. "Open for review" and **Preview** always open the window on purpose.
- **Nothing sent** – check the topic status line; "Nothing relevant" means no story reached your minimum relevance
  (enable *Send even when nothing is relevant* to get an email anyway).
- Debug log: **Tools ▸ Developer Tools ▸ Debug Add-ons ▸ RSS AI Digest ▸ Inspect**.

## Files

```
manifest.json        MV2 MailExtension manifest (Thunderbird 128+)
background.js        run pipeline, scheduling (alarms), message handling
lib/util.js          helpers (HTML→text, URL normalising, JSON parsing, templates)
lib/store.js         settings & providers, topics, templates, run state, seen-article memory
lib/ai.js            picks the configured provider
lib/deepseek.js      DeepSeek Chat Completions / Models client (JSON mode, thinking, retries)
lib/claude.js        Anthropic Messages / Models client (structured output, retries)
lib/sources.js       Thunderbird folder reader + RSS/Atom fetch & parse
lib/digest.js        prompt, JSON schema + example, result validation, HTML/text email rendering
lib/mailer.js        identity lookup; silent send (messages.sendMessage) or compose-window fallback
lib/schedule.js      daily / interval schedule maths
options/             settings page (provider connection, sending, topic editor)
popup/               toolbar popup (Run & send / Preview per topic)
```

## Development

```sh
npm install          # jsdom (+ playwright for the optional UI check: then run `npx playwright install chromium` once)
npm test             # unit + end-to-end tests with a mocked Thunderbird API
npm run test:ui      # renders the settings page and popup in Chromium (screenshots in test/output/)
npm run build        # dist/rss-ai-digest-<version>.xpi
```

The tests in `test/` load the add-on scripts into Node with a mocked `messenger` API
(`test/harness.js`), so they run without Thunderbird. Thunderbird itself ignores everything
outside the files packed by `scripts/build-xpi.sh`.
