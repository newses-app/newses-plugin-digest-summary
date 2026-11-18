# Newses digest summary plugin

A [Newses](https://newses.app) server plugin that opens each user's email digest with an overview of what is unread, and puts a one-line summary under each article, written by Claude through the Anthropic API.

## What is sent, and to whom

- Requests go to Anthropic (`api.anthropic.com`) with the server's API key, under the terms of that key's Anthropic account.
- For each article: its title, the name of its feed, and its text (at most 20,000 characters). For a digest: its language, and each listed article's title, feed name, and summary or the start of its text.
- Never sent: articles from feeds with a login, pages a user published from outside any feed, links, authors, and anything about the user.
- Only for users who turn the plugin on for themselves. Articles are summarised once each, and a summary is shared by every user with the same article in the same language.

## Install

The server's operator installs it at an exact version, as `@newses/plugin-digest-summary@0.1.0`:

- Docker: add it to `PLUGINS` in `.env` and start with the plugins override ([Self-hosting](https://newses.app/guide/self-hosting#plugins)).
- AWS: add it to the stage's `plugins` in the deployment config, then `scripts/store-deploy-config.sh --apply --release STAGE` ([Plugins](https://newses.app/guide/plugins)).

Then, in Settings > Plugins:

1. An admin creates an API key in the [Claude Console](https://platform.claude.com) (API keys), enters it, approves the host `api.anthropic.com`, and turns the plugin on for the server.
2. Each user who wants summaries turns it on for themselves under "For me", and presses "Send test": it checks the key and says how many tokens this month used.

## Settings

| Setting                         | Who   | What it does                                                                                                |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| Anthropic API key               | Admin | Every request is billed to it; a secret                                                                     |
| Model                           | Admin | Claude Opus 5.5 (default), Sonnet 5.5, or Haiku 5.5                                                         |
| Effort                          | Admin | How much the model thinks before it writes: low, medium (default), or high; higher costs more output tokens |
| Tokens a month, for the server  | Admin | 10,000,000 by default; once used, no requests are made until the month ends (UTC)                           |
| Tokens a month, for each user   | Admin | 1,000,000 by default; counts the summaries of articles a user's feeds bring first, and the user's overviews |
| Open my digest with an overview | User  | On by default                                                                                               |
| Summarise each article          | User  | On by default; articles are summarised as they arrive                                                       |

## How it works

| When                         | What happens                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Articles arrive              | Within 5 minutes of the first, those not yet summarised go to the Message Batches API as one batch, at half the price of direct requests. Summaries are written in the language of the user's last digest (English before the first) |
| Any later run                | Batches that have ended are collected: each summary is kept for 30 days, by the article's content and language                                                                                                                       |
| A digest is about to be sent | One direct request writes the overview and the summaries of listed articles still missing, from the start of their text; it must answer within the digest's minute, or the digest goes out with the summaries already kept           |

Feed text is treated as untrusted: it sits in the user turn, escaped inside tags; the system prompt says to summarise only, and to take no instructions from articles; and the answer must be JSON of the summary or overview alone (structured outputs).

When the model declines a direct request, the server's default fallback model answers instead (server-side fallback). Batches cannot fall back, so an article whose batch request was declined gets no summary. Answers that are cut off or not the format asked for add nothing, and the digest goes out without them.

## Costs

Every request is billed to the API key at [Anthropic's prices](https://platform.claude.com/docs/en/about-claude/pricing), per million tokens of input and output; thinking counts as output. Batches cost half. Rough sizes:

| Request              | Input tokens                                                  | Output tokens, thinking included |
| -------------------- | ------------------------------------------------------------- | -------------------------------- |
| An article's summary | 300 and about one per 4 characters of text, up to about 5,300 | 100 to 600, by effort            |
| A digest's overview  | about 1,000 and 100 per listed article                        | 300 to 2,000, by effort          |

Budgets count every token, input and output, of every attempt, fallbacks included. A batch is counted when it is sent, at about one token per 3 characters and 600 for its output, against the server's and the sending user's budgets; once it ends, the server's count is corrected to what it used. "Send test" shows the counts.

To choose the effort, measure it on digests like yours, billed to your key:

```sh
npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-... node scripts/measure-effort.mjs [DIGEST.json ...] --efforts low,medium,high
```

A digest file is what the plugin's `digest.compose` hook is given; [scripts/sample-digest.json](scripts/sample-digest.json) is the default, including an article that tries to give the model instructions.

## Failures

- A batch that cannot be sent fails the delivery, which Newses retries; after 10 failures in a row the plugin turns off for that user, and Settings > Plugins says why, such as "The API key was refused (HTTP 401)".
- A digest request that fails, is declined, or runs out of time leaves the digest with the summaries already kept, and never fails the digest.

## Development

Node 24 and npm: `npm install`, then `npm run check` (lint, typecheck, format check, tests) and `npm run build`. Tests run the hooks as the server does with `@newses/plugin-api/testing`, against a stand-in for the API answering with responses shaped as the API's (`src/test/`). Releases are version tags (`v1.2.3`), published to npm with provenance by the Publish workflow; the plugin's `version` in `src/index.ts` and `package.json` must match.

## Licence

AGPL-3.0-or-later, as Newses is.
