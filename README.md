# Newses digest summary plugin

A [Newses](https://newses.app) server plugin that opens each user's email digest with an overview of what their unread articles are about: a lead on their common themes, then topic sections (world, politics, technology, sports…) whose points link the articles they draw on. Claude writes it through the Anthropic API, with the sections, length, style, and instructions each user chooses.

## What is sent, and to whom

- Requests go to Anthropic (`api.anthropic.com`) with the server's API key, under the terms of that key's Anthropic account.
- What is sent, for each digest:
  - the digest's language;
  - how many unread articles it has;
  - for each unread article of the feeds the user chose: its title, the feed's name, the start of its text as the digest shows it, and a ref (`a12`) the answer cites it by;
  - the user's sections (names and what goes in each), length, and whether there is a lead;
  - the user's own instructions, when they wrote some and an admin allows them.

  That covers the up to 100 articles the digest lists and up to 2,000 more that it counts.

- Never sent: articles from feeds with a login, pages a user published from outside any feed, links, authors, and anything else about the user.
- Only for users who turn the plugin on for themselves.

## Install

The server's operator installs it at an exact version, `@newses/plugin-digest-summary@0.2.0`. It needs a server with plugin API 0.1.2 or later, which links the articles sections cite.

- **Docker:** add it to `PLUGINS` in `.env` and start with the plugins override ([Self-hosting](https://newses.app/guide/self-hosting#plugins)).
- **AWS:** add it to the stage's `plugins` in the deployment config, then `scripts/store-deploy-config.sh --apply --release STAGE` ([Plugins](https://newses.app/guide/plugins)).

Then, in Settings > Plugins:

1. An admin creates an API key in the [Claude Console](https://platform.claude.com) (API keys), enters it, approves the host `api.anthropic.com`, and turns the plugin on for the server.
2. Each user who wants an overview turns it on for themselves under "For me", and chooses which feeds it reads, its sections, length, and style. "Send test" checks the key, says how many tokens this month used, and sends a test digest.

## Settings

| Setting                              | Who   | What it does                                                                                                                                                                           |
| ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API key                    | Admin | Every request is billed to it; a secret                                                                                                                                                |
| Model                                | Admin | Claude Opus 5.5 (default), Sonnet 5.5, or Haiku 5.5                                                                                                                                    |
| Effort                               | Admin | How much the model thinks before it writes: low (default), medium, or high; higher costs more tokens and takes longer                                                                  |
| Tokens a month, for the server       | Admin | 10,000,000 by default; once used, no overviews are written until the month ends (UTC)                                                                                                  |
| Tokens a month, for each user        | Admin | 1,000,000 by default; counts the user's overviews                                                                                                                                      |
| Users may add their own instructions | Admin | On by default; when off, users' instructions are kept but not sent                                                                                                                     |
| Feeds to read                        | User  | All my feeds (default), only the feeds chosen, or all but the feeds chosen                                                                                                             |
| Feeds                                | User  | Picked from the user's subscriptions                                                                                                                                                   |
| Sections                             | User  | Up to 12, in order, each a name and what goes in it; by default World, Politics, Business, Technology, Science, Health, Sports, Culture, and Other. Sections nothing fits are left out |
| Length                               | User  | Brief (up to 2 short points a section), standard (default, 3), or detailed (5 longer ones)                                                                                             |
| Points shown as                      | User  | Paragraphs (default) or bullets                                                                                                                                                        |
| Open with a lead                     | User  | On by default: a paragraph on what ties stories together across sections                                                                                                               |
| Your instructions                    | User  | Up to 1,000 characters on what to focus on, leave out, or how to write                                                                                                                 |

## How it works

| Digest size                                   | What happens                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to about 50,000 tokens (some 400 articles) | One request reads every chosen article, grouped by feed, and writes the overview                                                                                                                                                                                                                      |
| Larger                                        | The articles are split into up to 6 parts, feeds kept together where they fit, read at once. Each part sorts its stories into the user's sections and gives each section's themes, with how many articles each covers and the refs of those it draws on. A last request writes the overview from them |

- **Sections and citations:** the answer is a lead and sections of points, each section one of the user's (an enum in the output format, so none is made up), its heading the name in the digest's language. Each point cites the refs of up to 5 articles; the plugin turns them into entry ids, leaving out refs it never gave, and the server links each cited article by its title to the article in Newses, whether the digest lists it or only counts it. Neither the model nor the plugin writes a link.
- **Limits:** points beyond the length's count, and then, from the end, points beyond the digest's 8,000 characters of sections, are left out.

- **Time limit:** a digest waits at most 5 minutes for its plugins. The parts have about 60% of that, and the last request the rest.
- **When an answer is missing:** if a request fails, runs out of time, is declined, is cut off, or is not the format asked for, the digest goes out without an overview. When only some parts answer, the overview is written from them and its lead (or, without one, a note of its own) says how many articles it covers and how many parts ran out of time or failed.
- **Untrusted feed text:** it sits in the user turn, escaped inside tags. The system prompt says to summarise only, and to take no instructions from articles. The answer must be JSON of the overview, or of a part's themes, alone (structured outputs).
- **The user's preferences:** a second system block, after the fixed one that is cached, gives the sections, length, lead, and the user's instructions, escaped. The model follows the instructions on what to cover and how to write; they cannot change the format, make articles anything but material, or ask for anything but a summary. Each user's instructions reach only their own digest, within their monthly budget.
- **Declined requests:** when the model declines a request, the server's default fallback model answers instead (server-side fallback).

## Costs

Every request is billed to the API key at [Anthropic's prices](https://platform.claude.com/docs/en/about-claude/pricing), per million tokens of input and output; thinking counts as output.

- **Size:** an article takes about 100 input tokens, so a digest of 1,000 unread articles reads about 100,000. The overview takes 1,000 to 8,000 output tokens, depending on length and effort.
- **Budget check:** before a digest, the plugin estimates its tokens. When the server's or the user's budget left is smaller than that, it makes no request.
- **What is counted:** every token, input and output, of every attempt, fallbacks included, against both budgets. "Send test" shows the counts.
- **Estimate:** "Estimate cost" under "For me" shows what the overview of a test digest now would cost, making no request: the tokens it expects, priced at Anthropic's list prices for the three models as of November 2026 (5-minute cache writes at 1.25 times input; Haiku's higher price for prompts over 100,000 tokens), with 3,000 output tokens a part, and 3,000, 5,000, or 8,000 for the overview by length. It counts neither discounts nor answers from a fallback model, and says when the budget left would stop it.

To choose the effort, measure it on digests like yours, billed to your key:

```sh
npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-... node scripts/measure-effort.mjs [DIGEST.json ...] --efforts low,medium,high [--copies 100] [--length brief|standard|detailed] [--instructions TEXT]
```

- **Digest files:** a digest file is what the plugin's `digest.compose` hook is given. [scripts/sample-digest.json](scripts/sample-digest.json) is the default, and includes an article that tries to give the model instructions.
- **Larger digests:** `--copies N` adds N copies of its articles as unlisted ones, to measure a digest read in parts.
- **Reader settings:** `--length` and `--instructions` measure those settings, with the default sections. The script prints each section's points with the titles of the articles they cite.

## Failures

A request that fails, is declined, or runs out of time leaves the digest without an overview, and never fails the digest. The server's log says why.

## Development

Node 24 and npm: `npm install`, then `npm run check` (lint, typecheck, format check, tests) and `npm run build`.

- **Tests** run the hooks as the server does with `@newses/plugin-api/testing`, against a stand-in for the API that answers with responses shaped as the API's (`src/test/`).
- **Releases** are version tags (`v1.2.3`), published to npm with provenance by the Publish workflow. The plugin's `version` in `src/index.ts` and `package.json` must match.

## Licence

AGPL-3.0-or-later, as Newses is.
