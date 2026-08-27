# Renderball — Go-To-Market Playbook

> **STALE (pre-pivot) — do not execute (founder call 2026-07-28).** The
> locked GTM is: "editing is the moat" + full build-in-public. This playbook
> predates the canvas pivot and is kept for reference only.

A standalone GTM document. Anchors the customer development gate, the launch motion, and the acquisition channels for Days 1–90. Companion to PRODUCT.md (the product spec) and PROCESS.md (the original FUSE deck process).

---

## Philosophy

**Customer development comes before code. Always.**

The cost of being wrong about which segment to build for is 3 weeks of wasted engineering time minimum, plus the psychological tax of pivoting after shipping. The cost of validating first is 14 days of founder time and ~$650 in tooling and ad spend. The math is obvious; the discipline to actually do it is the hard part.

The Week 0 customer development sprint runs as a complete, blocking gate before Day 1 of the build sprint. Build doesn't start until validation passes. If validation fails, the build target changes — possibly the wedge changes entirely — before any line of code is committed.

**Three Week-0 outputs unlock the rest of the GTM motion:**
1. Confirmed wedge segment (YC launch cohort OR mid-market marketing teams OR both)
2. 5–10 warm pre-launch contacts who are likely first paying customers
3. Validated landing page copy + pricing + positioning calibrated to real customer language

Everything in this document — the launch, the acquisition channels, the YC application narrative, the enterprise sales motion — depends on Week 0 producing real validation data, not assumptions.

---

## Updated sprint timeline

The validation-before-code call shifts the public launch from Day 21 to **Day 35**. Total schedule:

| Phase | Days | What happens |
|---|---|---|
| **Week 0 — Validation** | Days 1–14 | Customer development (10 days) + SEO/CTR test (14 days in parallel) |
| **Decision gate** | Day 10 | Customer dev synthesis → proceed / pivot / kill |
| **Weeks 1–2 — Build sprint** | Days 15–28 | Pipeline, agents, schema, pre-render gate, audio, billing, anti-abuse |
| **Week 3 — Hardening + closed beta** | Days 29–34 | Synthetic transaction testing, anti-abuse stress test, closed beta with 30 invited customers (no free tier yet) |
| **Public launch** | **Day 35** | Free tier opens; ProductHunt + YC alumni Slack + Twitter/LinkedIn launch threads |

The 14-day extension over the original Day-21 launch is the cost of validation. Worth it.

---

## Week 0 — Customer Development Sprint (Day-by-Day)

### Day 1 — Build the target lists

**Output:** Two named lists in Airtable/Notion. Each row has: Name, Title, Company, LinkedIn URL, Twitter handle (if YC founder), Email (best guess), Mutual connection (yes/no), Outreach status (not-sent), Notes.

**List A — Mid-market marketing leads (target: 30 names)**

Where to find them:
- LinkedIn Sales Navigator filter: *"Head of Marketing" OR "Demand Gen" OR "Product Marketing Manager" OR "Marketing Lead" OR "CMO"* + *Company size: 50–500 employees* + *Industry: SaaS / Fintech / Tech / Healthcare Tech / Marketing & Advertising* + *Company HQ: United States*
- Companies the founder knows personally (FUSE network, ex-colleagues at other startups, founders met at events)
- Companies that recently shipped a launch video in the last 90 days (LinkedIn search for "excited to announce" + video posts)
- Y Combinator company list (alumni Series A–C companies that hire marketing leads)

**Qualification criteria for List A:**
- Company has shipped at least one branded launch/feature video in the last 12 months (visible on their LinkedIn / website)
- Company size 50–500 (mid-market — they have a marketing budget but no in-house motion design team)
- Series A or later (they have money to spend on video)
- The person in the role has 12+ months tenure (long enough to have procured a video before)

**Disqualify:**
- Enterprise (1000+ employees) — they likely have in-house creative teams, longer sales cycles
- Pre-seed / seed (under 20 employees) — they don't pay $500–1k/video
- Agencies (they're the supply side, not the demand side)

**List B — YC founders launching in the next 90 days (target: 20 names)**

Where to find them:
- BetaList — recent launches from YC-funded companies
- ProductHunt — recent launches with YC tags
- YC alumni LinkedIn (S25, W26, S26 batch members)
- Founder Twitter — people who tweet "we just launched X at @ycombinator"
- Hacker News "Show HN" posts from YC companies (last 90 days)

**Qualification criteria for List B:**
- Founder is the primary public face of their company (CEO, solo founder, or technical co-founder who does marketing)
- Their company has shipped or is about to ship a public launch (PH, BetaList, Show HN)
- Active on Twitter/X (their primary distribution channel)
- 1–10 employees (small team, founder makes all marketing decisions)

**Practical tactical notes:**
- LinkedIn Sales Navigator free trial month covers Week 0; cancel before billing
- Hunter.io free tier (25 lookups) for email finding; pay $50/mo if you exhaust it
- Don't over-research — 30 names in 4 hours is the goal, not 30 perfect names in 12 hours

### Day 2 — Write outreach templates

**Output:** Four templates (LinkedIn connect, LinkedIn DM, Email, Twitter DM), each 2–3 variants for A/B testing.

**Template 1 — LinkedIn connection request (List A, mid-market)**

300-char limit. Specific, concrete, gives them context, has a clear ask.

> *Hi [Name] — I'm at FUSE Finance. We were paying agencies $500–1k per launch video before I built an internal tool that replaced it. I'm researching whether other mid-market marketing teams have the same situation. 15 min to compare notes?*

Variant A (FUSE-anchored — use as default):
> *Hi [Name] — At FUSE Finance we were spending $500–1k per launch video at outside agencies. I built an internal tool that replaced that spend at 95% lower cost. I'm researching whether other Series A–C marketing teams have the same problem. 15-min call?*

Variant B (curiosity-led):
> *Hi [Name] — quick research question: how does your marketing team currently handle animated launch videos? Agency? In-house? Hybrid? I'm exploring this space and would love 15 min to learn how you've solved it.*

Variant C (specific reference):
> *Hi [Name] — saw [Company]'s recent launch on LinkedIn — strong work. I'm researching how marketing teams at companies your size procure animated video. At FUSE we were spending $500–1k/video before I built an internal replacement. 15 min to compare notes?*

**Template 2 — LinkedIn DM (after connection accepted)**

Send same day they accept. Three specific time slots beat a calendar link for first call — feels less corporate.

> *Thanks for connecting, [Name]. I'm trying to talk to 5–10 marketing leads about how they currently handle launch / feature videos — what you pay, what works, what doesn't. Would [Tuesday 2pm PT / Wednesday 11am PT / Thursday 4pm PT] work for a quick 15-min call? Happy to share what we learned at FUSE in exchange.*

**Template 3 — Email follow-up (if no LinkedIn response in 4–5 days)**

Find the email via Hunter.io / Apollo / company team page. Reference the LinkedIn ping.

> *Subject: Quick question about launch video at [Company]*
>
> *Hi [Name],*
>
> *Sent you a LinkedIn note last week and wanted to follow up here in case it got buried. At FUSE Finance, we were spending $500–1k per launch video at outside agencies — I built a code-driven internal tool that replaced it at ~95% lower cost. Now I'm trying to learn whether other mid-market marketing teams have the same problem (or solved it differently).*
>
> *Would a 15-minute call next week work? Happy to share what we learned at FUSE in exchange.*
>
> *Thanks,*
> *Alfonso Garcés*
> *[LinkedIn URL]*

**Template 4 — Twitter/X DM (List B, YC founders)**

Lowercase, conversational, no formality. That's the YC Twitter dialect.

> *hey [name] — saw your launch this week. quick question: how did you make the launch video? if you paid an agency, what'd it cost? if you DIY'd, what tool? I'm building something in this space and trying to learn what would actually be useful. 15 min call this week?*

Variant for YC founders who haven't launched yet:
> *hey [name] — saw you're shipping in [month]. quick question: how are you planning to make your launch video? curious about the marketing prep side. building something in this space — 15 min call would be useful for me, possibly useful for you.*

### Day 3 — Send first batch (target: 25 outbound touches)

**Sequencing:**
- Morning (Tue–Thu, 9–11 AM in their timezone): LinkedIn connect requests for 15 List A targets
- Afternoon (1–4 PM in their timezone): Twitter DMs for 10 List B targets
- End of day: log all outbound in the tracking sheet

**Don't batch with copy-paste — personalize each one.** Variant A or B or C of the LinkedIn template depending on whether you have a specific reference for that person (recent launch, mutual connection, shared interest). Personalization is the difference between 5% and 30% response rates.

**Tracking sheet schema:**

| Date sent | Channel | Name | Company | Variant | Status | Response date | Call booked? | Call done? | Notes |
|---|---|---|---|---|---|---|---|---|---|

Update daily. Don't let this become a black hole — knowing what's pending is half the value.

### Day 4 — Send second batch (target: 25 more outbound touches)

- Morning: LinkedIn connect requests for the remaining 15 List A targets
- Afternoon: Twitter DMs for the remaining 10 List B targets
- Continue updating tracking sheet

By end of Day 4: 50 outbound touches sent. Start receiving connection accepts (typically 24–48h after send).

### Day 5 — DM accepted connections + send email follow-ups

By Day 5, you'll have ~12–15 LinkedIn connection accepts. Send the Template 2 DM to each, with three specific time slots.

For any List A targets who haven't accepted LinkedIn in 48h, send the Template 3 email follow-up. Reference the LinkedIn ping.

Target end-of-Day-5 state:
- 12–15 LinkedIn DMs sent (to accepted connections)
- 10–15 email follow-ups sent (to LinkedIn non-responders)
- 3–5 Twitter DM responses (YC founders move fast)
- 2–4 calls already booked

### Day 6 — Run first calls + send second-round nudges

By Day 6, 4–8 calls should be booked across Days 6–9. Run the first ones. See **Call structure** below for the script.

Between calls:
- Reply to any Twitter responses
- Send polite "just checking back" nudges to LinkedIn DM non-responders (give 48h before nudging)

### Day 7 — Run more calls + start synthesis

Run the next batch of booked calls. After each call:
- Write up notes within 30 minutes (memory fades fast)
- Tag key quotes verbatim
- Note: did this person confirm the FUSE pattern? Did they show interest at $9.99/min?

Start a synthesis doc with running themes — what's repeating across conversations?

### Day 8 — Final calls + emergency outreach

Last day of calls. If you're below 5 total calls done, send 10 more emergency outbound touches with a more aggressive ask:

> *Hi [Name] — quick follow-up: I'm running customer research this week and have 2 days left. Even a 10-minute call would be useful. I'm specifically trying to understand how you currently procure launch video. Happy to compensate for your time with a $20 Amazon gift card or a coffee chat at [local cafe]. Available [specific 4-hour window].*

Time-boxing + small token of compensation can unlock late-stage outreach. Don't lead with this from Day 1 (degrades the conversation), but Day 8 is fair game.

### Day 9 — Synthesis day (no calls)

Spend the day in deep synthesis. Output: a 2-page memo titled "Week 0 customer development findings" with these sections:

**Section 1 — Calls completed.** List every call: name, company, role, key quote, FUSE-pattern fit (yes/maybe/no), $9.99/min reaction (positive/neutral/negative), willingness to be a beta customer (yes/maybe/no).

**Section 2 — Themes across List A (mid-market).** What patterns repeated? What surprised you? What did *every* respondent say? What did *no one* say (the dog that didn't bark)?

**Section 3 — Themes across List B (YC founders).** Same structure. Different patterns expected — YC founders are more price-sensitive, more self-service, less likely to have current agency relationships.

**Section 4 — Pricing signal.** Did $9.99/min feel cheap to mid-market? Expensive to YC founders? Did anyone counter-offer a different price?

**Section 5 — Wedge signal.** Which segment showed stronger interest? Stronger willingness to be a beta customer? Stronger conviction about Renderball-as-described?

**Section 6 — Surprises and pivots.** What did you learn that you didn't expect? Did anyone describe a use case you hadn't considered? Did anyone reject the premise entirely?

### Day 10 — Decision gate

Based on the synthesis, make the wedge decision per the criteria below. This is a hard gate — don't proceed to build until the decision is made and documented.

**Decision criteria:**

| Outcome of Week 0 | Decision |
|---|---|
| ≥4/5 mid-market AND ≥4/5 YC founders confirm interest | Proceed with current plan — YC beachhead as launch GTM, mid-market as Day-60+ expansion |
| ≥4/5 mid-market confirm, but ≤2/5 YC founders show interest | **Switch beachhead to mid-market.** Drop YC launch positioning. Lead with FUSE-pattern messaging. Re-target outreach to mid-market marketing leads from Day 35 onward. |
| ≥4/5 YC founders confirm, but ≤2/5 mid-market | **Narrow the build to YC-launch-video-specific use cases.** Drop mid-market enterprise tier from V1 roadmap. Reposition as "AI launch video for YC founders." |
| <3/5 from both segments | **Pivot or kill.** Don't build. Either redesign the wedge entirely (different segment, different problem statement) or shelve the project for 6 months and revisit. The plan is wrong. |
| Mixed or ambiguous | Run a second week of outreach with refined messaging. Don't proceed on ambiguous data. |

**Day 10 deliverable:** a one-page decision memo named `~/.gstack/projects/renderball-product/week0-decision.md` with: outcome (proceed / switch / narrow / pivot / kill), reasoning (referencing the synthesis), updated wedge segment + ICP, updated landing page copy direction, list of 5–10 warm beta candidates from Week 0 conversations, and Day 15 build sprint kickoff status.

### Week 0 budget summary

| Line | Cost |
|---|---|
| LinkedIn Sales Navigator (1 month) | $80 |
| Hunter.io email finder ($50/mo if free tier exhausted) | $0–50 |
| Google Ads SEO test (parallel track) | $500 |
| Notion / Airtable tracking (free tier) | $0 |
| Coffee / gift cards for emergency outreach (Day 8) | $50 |
| **Total Week 0 budget** | **~$630–680** |

Time investment: ~6–10 hours/day of founder time across 10 working days = 60–100 hours total. Big lift, but the right lift.

---

## Call Structure — The 30-Minute Discovery Call

### Pre-call (5 min)

- Review the person's LinkedIn, recent posts, their company's last launch
- Find one specific thing to reference in the first 60 seconds ("saw your post about X")
- Have the tracking sheet open, ready to type notes

### Opening (3 min)

> "Thanks for taking the time. I'll keep this to 15 minutes — although if it's useful for both of us we can go to 30. I'm trying to understand how marketing teams currently handle launch / feature videos — what's working, what's not. I'm not trying to sell you anything today; I'm doing research before I commit to building something. Sound good?"

This frames it as research, not sales. Lowers their guard. Makes them more honest.

### Discovery questions (15–20 min) — in order

The questions are designed to surface concrete pain, real spending, current workflow, and emotional reaction. Verbatim quotes are gold.

**Q1 — The last video they made:**
> "Walk me through the last branded animated video your team commissioned. Could be a launch, a feature reveal, a customer story, anything. Start from the beginning — what was the brief, who made it, what came back?"

Push for specifics: dates, vendor names, costs, turnaround times, number of revision rounds.

**Q2 — The pain:**
> "What was painful about that process? Where did it break? What would you change if you could?"

Listen for emotional language — "frustrating," "took forever," "looked nothing like what we asked for." Those are signal.

**Q3 — The cost:**
> "What did that video cost you? And roughly how many do you commission per year?"

Specific dollar amounts. Annual spend matters more than per-video cost — that's the budget line item Renderball replaces.

**Q4 — The alternatives:**
> "Have you ever considered building this in-house? Using a tool? What stopped you?"

Surfaces the make-vs-buy decision. Often the answer is "we don't have the design talent" or "the tools we tried looked too generic." Both validate Renderball.

**Q5 — The dream:**
> "If you could wave a magic wand and have launch videos appear exactly the way you want, faster and cheaper than your current process, what would that look like?"

Listen for whether their dream matches Renderball's actual product surface. If they say "I want an AI avatar to read our script," that's a Synthesia answer, not a Renderball answer. Important data.

**Q6 — The price test:**
> "If I told you there was a tool that produced agency-quality animated launch video — your brand, your fonts, your colors, with a script you approve before render — for $9.99 per minute of video... what would your reaction be?"

Watch for the reaction. Genuine surprise + "that's incredible" = positive signal. Skeptical "what's the catch" = neutral. "We'd never use a tool we don't trust" = negative.

**Q7 — The beta ask:**
> "I'm building this. Public launch is in ~5 weeks. If it works the way I think it will, would you be open to being one of the first paying customers? I can send you a beta invite when it's ready."

This is the ask. Their answer tells you everything. "Yes, send it" = warm pre-launch lead. "Maybe" = soft signal. "Probably not" = honest signal that this person isn't your customer.

### Closing (2–3 min)

- Thank them
- Ask: "Is there anyone else in your network you think I should talk to about this?" — referrals compound
- Send a 1-paragraph follow-up email within 24h thanking them with one specific thing they said that you found useful (shows you listened)

### Post-call (10 min)

- Write up notes immediately while memory is fresh
- Tag the call: FUSE-pattern fit (yes/maybe/no), $9.99/min reaction (positive/neutral/negative), beta interest (yes/maybe/no)
- Save 2–3 verbatim quotes that could go on the landing page

---

## SEO/CTR test (Week 0 parallel track)

Already documented in PRODUCT.md → Week 0 Track 1. Quick recap:

- $500 budget, 14 days, 10 candidate phrases
- One-page landing site with email capture
- Measure CTR + email-signup-per-ad-group
- Winning phrase becomes the H1 + meta + paid keyword
- "Animation-rich" stays as brand positioning regardless

The two tracks (customer development + SEO test) measure different things:
- **Customer development** = what real buyers will pay for (revenue-side validation)
- **SEO test** = what unknown buyers search for (acquisition-side validation)

Both inputs are needed before Day 15 build sprint kickoff.

---

## Post-Week-0 GTM (Days 15–90)

What happens after Week 0 validation passes, assuming the proceed-with-current-plan outcome.

### Days 15–28 — Build sprint (in parallel with GTM prep)

While engineering runs, GTM prep continues in parallel (low-burn, no full-day commitments):

- **Daily:** Maintain the public changelog at renderball.com/changelog (Moat 8). Every shipped feature gets a one-liner.
- **Twice weekly:** Founder Twitter/LinkedIn post about what shipped + what was hard. Builds the launch audience.
- **Weekly:** Re-engage the 5–10 Week-0 warm contacts with a short update: "Here's what we shipped this week. Beta invite coming Day 28."
- **Day 24:** Closed beta invitations sent to all Week-0 warm contacts who said yes to the beta ask.
- **Day 26:** ProductHunt launch post drafted, scheduled for Day 35.
- **Day 27:** Hacker News "Show HN" post drafted.

### Days 29–34 — Closed beta + final polish

- **Day 29 (Mon):** Closed beta opens to 30 invited customers (all paying $9.99/min PAYG — no free tier yet). 5–10 of these are Week-0 warm contacts; 20 are friends-of-friends.
- **Days 29–34:** Rapid bug-fix cadence. Direct founder DM as the support channel. Each bug fixed within hours becomes a customer-love moment.
- **Day 33:** Final landing page polish — bake in 2–3 verbatim quotes from Week 0 conversations. ("We were spending $X/year on agency video before Renderball" — anonymized or with permission).
- **Day 34:** YC alumni Slack + Bookface posts drafted (only if Alfonso has alumni access, otherwise via mutual connections).

### Day 35 — Public launch

**Launch-day sequence (in order, over 24h):**

1. **Midnight PT:** Free tier opens. Renderball.com homepage updated with launch copy.
2. **6 AM PT:** ProductHunt launch post goes live. Founder posts in PH chat throughout the day.
3. **6 AM PT:** Hacker News "Show HN: Renderball — animation-rich video from a prompt" submitted. Founder responds to every comment.
4. **8 AM PT:** Twitter/X launch thread (5–7 tweet thread with the recursive hero video, the FUSE origin story, the pricing, the beta-customer quotes).
5. **9 AM PT:** LinkedIn long-form post (1500 words, the FUSE origin story in detail).
6. **10 AM PT:** Direct DM to every YC alumni founder who said "send me the beta" in Week 0 — "We're live. Make your first minute free at renderball.com."
7. **Throughout the day:** Engage every comment, reply to every DM, post screenshots of cool customer videos to social.

**Day-35 success criteria:**
- 50+ ProductHunt upvotes (achievable with YC alumni network support)
- HN front page (top 30) for at least 4 hours
- 200+ free tier signups by end of day
- 5+ paying customers by end of day

### Days 36–90 — Growth phase

This is where the four-pillar acquisition motion runs in parallel:

#### Acquisition Channel 1 — Founder content

**Cadence:** Twitter/LinkedIn daily posts. 1 long-form blog post per week at renderball.com/blog.

**Themes that work:**
- "What we shipped this week" (uses Moat 8 — visible velocity)
- "Customer story: [Company] made 5 videos in 30 minutes" (with permission, with screenshots)
- "How we built X" (technical deep-dives that recruit engineering interest)
- "The economics of code-driven video vs diffusion video" (positioning content)
- "What we learned from 100 customer calls" (research-driven content)

**Goal:** 5K Twitter followers + 2K LinkedIn followers by Day 90. This is the founder's distribution moat for the rest of the company's life.

#### Acquisition Channel 2 — Free tier gallery flywheel

Moat 9 in action. Every free tier render is public by default → indexed for SEO → entry point for new customers → some convert to paid.

**Operational:**
- SEO-friendly gallery URLs go live Day 35
- Sitemap.xml regenerates nightly
- Gallery pages link to the brief excerpt + "Remix this" + "Make your own — free" CTAs
- Customer moderation: any QA-flagged video stays hidden from gallery until reviewed

**Goal:** 1,000+ gallery pages indexed by Day 60, 50K+ monthly organic gallery visits by Day 90.

#### Acquisition Channel 3 — YC alumni network

If Week 0 confirmed the YC beachhead:
- Day 35 onward: weekly post in YC alumni Slack with a customer story or shipped feature
- Direct outreach to YC partners with the customer evidence: "We launched, here's our 30-day metrics, we'd love a partner intro to YC W27 founders who might benefit"
- Founder attendance at YC alumni events (in-person matters here)

If Week 0 pointed to mid-market instead:
- Skip this channel. Don't force the YC narrative where the data doesn't support it.

#### Acquisition Channel 4 — Outbound sales (mid-market, optional)

If Week 0 confirmed the FUSE pattern at mid-market:
- 5 personalized cold emails per day to mid-market marketing leads (1 hour of founder time)
- Hit rate target: 1–2 booked calls per week
- Average ACV target: 2 PAYG videos / month + subscription = ~$60/customer/month
- Conversion target: 30% of calls → paid customer

This is the founder's *first* sales channel. Real outbound, real conversations, real customers. Slower than viral but compounds with case studies.

### Day 60 — V1.5 ships

- Multi-language render mode
- Variant generation mode
- License manifest export endpoint + named-approver workflow (enterprise tier prep)
- First integration ships (Slack or Linear)
- Renderball-Coder-V0 trained on Days 1–60 corpus; tested

By Day 60: $3–5K MRR target hit (if Week 0 validation was strong). If below $2K MRR, the GTM motion needs honest reassessment.

### Day 90 — V2 ships + YC application

- Full V2 API with multi-tenant support + TypeScript SDK
- Embed widget
- Multi-format render
- Enterprise tier ($1,500/mo) opens with first 2–3 customers
- **YC application submitted** with: 60-day MRR, retention curve, customer testimonials from Week-0-validated buyers, the FUSE origin story as the founder narrative

The strongest YC application says: "I built this for the company I worked at, replaced $X of agency spend, talked to 30 marketing leads in Week 0 to validate it generalized, launched Day 35, hit $X MRR by Day 90, and Y of my first 50 customers are YC alumni." Each clause is evidence-backed.

---

## Beyond Day 90 — Long-term GTM strategy

### Months 4–6 — Land enterprise

- Trigger: YC funding closes (assuming acceptance)
- First hire: customer success / enterprise sales lead (matches Moat 6 monetization timing)
- Target: 5 Enterprise Lite contracts ($1,500/mo) + 1 Enterprise Standard ($5,000/mo) by Month 6
- Acquisition: inbound from Renderball customer base (companies that exceed $500/mo on PAYG get nudged to enterprise), plus founder-led outbound to F500 marketing teams

### Months 6–12 — Pursue the Stripe-of-video opportunity

- Trigger: direct B2B at $1M ARR and stable
- First integrator conversations with HubSpot / Linear / Notion / Webflow alumni networks
- Architecture-ready (multi-tenant API designed in V2) — execution is sales + partnerships
- This is when the second hire happens (technical partnerships PM)

### Year 2+ — Infrastructure layer

The full Moat 7 thesis plays out. Renderball becomes the rendering backend that other SaaS products call when they ship video features.

---

## GTM metrics dashboard

What gets measured weekly from Day 35 onward. Owner: founder.

| Metric | Target Day 60 | Target Day 90 | Target Day 180 |
|---|---|---|---|
| Total signups (free + paid) | 500 | 2,000 | 10,000 |
| Paid customers | 30 | 150 | 600 |
| MRR | $1,500 | $5,000 | $20,000 |
| Free → paid conversion | 8% | 12% | 15% |
| Renders per paid customer per month | 3 | 4 | 5 |
| Gallery page organic traffic / month | 500 | 5,000 | 30,000 |
| Founder Twitter followers | 2,000 | 5,000 | 15,000 |
| Net Promoter Score (sampled) | not measured | 40+ | 50+ |
| First enterprise contract | — | — | 1+ |
| Cumulative renders in corpus (Moat 5 fuel) | 5,000 | 25,000 | 200,000 |

If metrics significantly underperform target, the GTM motion needs honest reassessment, not more grinding.

---

## What we are NOT doing on GTM (scope discipline)

- **No paid ads beyond the Week 0 SEO test until $10K MRR.** Bootstrap means organic first. Paid ads come when the unit economics on inbound are proven.
- **No SEO content farm.** Quality blog posts only — 1 per week max, written by the founder, deeply researched. The gallery handles the volume SEO play.
- **No outbound sales team in Year 1.** Founder-led outbound only. Hire the first sales person at $25K+ MRR if mid-market motion proves out.
- **No reseller / affiliate program in Year 1.** Distracts from direct relationships. Revisit Year 2 when the brand is established.
- **No conference sponsorships.** Too expensive for the bootstrap stage. Speaking at conferences is free and higher-ROI.
- **No press releases.** Coverage comes from doing remarkable things, not from PR firms. Renderball-itself launching on Renderball is the press release.

---

## The single most important rule

**Customer development never stops.** Week 0 is the gate; after that, the founder talks to 5 customers per week for the first 6 months. Every paid customer gets a 15-min call within 2 weeks of signup. Every churned customer gets an exit interview. Every enterprise prospect gets a 30-min discovery before any contract conversation.

The Year 1 founder who knows their customers wins. The Year 1 founder who hides behind product launches and Twitter loses. Renderball's moat compounds with every conversation, not just every shipped feature.
