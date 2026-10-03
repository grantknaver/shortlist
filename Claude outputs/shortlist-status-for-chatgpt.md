# Shortlist — current status (October 3, 2026)

Paste this into ChatGPT as context. It's everything needed to start selling.

## What it is
Shortlist is a prospecting tool for roofing companies in **Bend, Oregon**. A roofer presses **Find Opportunities**, and it ranks every single-family home in Bend by how worth knocking on it is. It combines three signals from public records:

- **Old roof:** no reroof permit in 15+ years. Bend requires permits for reroofs, so permit history is reliable.
- **Storm exposure:** hail or wind reported nearby by the National Weather Service.
- **Neighbors reroofing:** a higher-than-normal share of nearby homes reroofed after the storm.

Homes that already got a new roof are removed automatically. Every result explains why it surfaced and suggests an outreach angle. The roofer can export the list as a spreadsheet (CSV).

**What it is not:** these are prospects, not inbound leads. Storm exposure is not confirmed damage. Never tell a homeowner "your roof is damaged."

## Status: ready to sell
- Live at **https://shortlist-air.pages.dev**. The backend runs on Render (Standard plan, $25/mo) and the website on Cloudflare (free).
- Full customer walk-through tested on Oct 3 and passed:
  - a live Bend search finishes in about 60 seconds and checks 33,245 homes;
  - the #1 result shows all of its evidence correctly;
  - CSV export works;
  - the sample link is limited and can't export.
- Access keys were moved out of the code. The old `demo` and `sample` keys no longer work.
- Accuracy: the top 20 results were independently checked against city, county and weather records, and **all 20 passed**.

## Links
- **Sample link for prospects:** https://shortlist-air.pages.dev/?key=WCsqMRy4tiYl8uPp
  - Shows real Bend homes, no export.
  - The limit is being changed from 10 homes to **5**. The change is pushed to GitHub but not deployed yet: in Render, click Manual Deploy → Deploy latest commit.
- **Full-access link:** this is Grant's own demo key. It's stored in Render (Environment → `ACCESS_KEY_DEMO`). Don't share it with prospects or paste it anywhere public.

## Current numbers (Bend)
- 33,245 single-family homes checked.
- 3,232 already reroofed within 15 years, so removed.
- 350 rated **Very High**, 1,517 High.
- What drives the current list: one measured **1.5" hail storm on Aug 3, 2025** in SE Bend. It's the only credible severe storm in the last 2 years.
- Near the top homes, **about 8.5% of neighbors reroofed after the storm, compared with about 1.7% before it**.
- **Example #1 result: 1163 SE Shadowood Dr**
  - Very High, score 98
  - Roof about 34 years old (built 1992, never reroofed)
  - Hail measured 0.64 mi away
  - Suggested angle: "Offer a free roof inspection… frame it as a check-up, not a damage claim."
- **Caveat:** the top homes cluster in one SE Bend subdivision because there's been only one recent storm. A new storm refreshes the list.

## Who to sell to and how
- **Target:** Bend roofing companies that door-knock, canvass or do direct mail. Storm and restoration roofers are the best fit.
- **Pitch:** "Which houses in Bend should your crew knock on this week? This shows you, and explains why for each one."
- **Demo (about 3 minutes):**
  1. Open the full link and choose Bend → Live data → Find Opportunities.
  2. Open the #1 result and read the roof, storm and neighbor evidence out loud.
  3. Show the CSV export.
- **Trial:** send the sample link (5 homes, no export).
- **Pricing idea (not yet tested):**
  - about $299–499 per month per roofing company;
  - one roofer per area, so exclusivity is part of the pitch;
  - a founding-customer discount for the first 1–2 clients.
- **How the roofer uses it:** door-knocking, door hangers, direct mail. **No cold texting or robocalling** from the list, because US law (the TCPA) requires consent for those.
- **Be upfront that:**
  - storm exposure ≠ damage;
  - storm reports are accurate to roughly 0.5–2 miles;
  - Bend is the only validated market.

## Common objections
- **"We already know where the hail hit."** It shows which exact houses still have old roofs and haven't reroofed, and removes the ones that already did.
- **"Are these leads?"** They're prioritized prospects: a smarter knock list, not inbound calls.
- **"How do you know the roof is damaged?"** We don't claim that. It's old roof plus storm plus neighbors reroofing, which is where inspections turn into jobs.

## When a roofer pays (setup takes about 5 minutes)
1. Create a customer file `server/config/customers/<name>.json` with their name, service area and limits. There's no key inside the file.
2. Add a random key in Render: Environment → `ACCESS_KEY_<NAME>`.
3. Push the code, then Render → Manual Deploy → Deploy latest commit. Render does **not** redeploy on its own.
4. Send them `https://shortlist-air.pages.dev/?key=<their key>`.

## Loose ends
- **Render billing:** switch the workspace plan back to **Hobby** (Pro was chosen by mistake) and ask Render support to refund the Pro charge.
- **Deploy the 5-home sample change:** Render → Manual Deploy.
- **Optional:** make the GitHub repo private. Give Render's GitHub app access to it first, or Render can't pull updates.
- **Not built (on purpose):** user logins, billing, saved run history, maps, AI-written outreach, and markets other than Bend. Runs are kept in memory only, so export right after running.
