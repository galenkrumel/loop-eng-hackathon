# Recruit Enrichment Pipeline (Zero.xyz / x402)

Given a **LinkedIn username** and a recruit's **name**, build an enriched profile:
photos **plus** GitHub, personal website, and other social/web links (and optionally
email/phone). Primary identity source is LinkedIn; everything else is discovered
from there and filled in from the cheapest reliable source per field.

Sources are pay-per-call capabilities on [zero.xyz](https://zero.xyz) via the `zero`
CLI (x402 micropayments, USDC on Base) — **except GitHub, which is free and native**
(see §2). All prices, latencies, and field names were verified against a live target
(`constantin-ertel` / "Constantin Ertel") on 2026-07-17.

---

## Inputs / Output

```jsonc
// input
{ "linkedinUsername": "constantin-ertel", "recruitName": "Constantin Ertel" }

// output
{
  "name": "Constantin Ertel",
  "headline": "ML Ops @Encord | Prior Engineering @UC Berkeley",
  "company": "Encord",
  "location": "San Francisco Bay Area",
  "links": {
    "linkedin":  "https://www.linkedin.com/in/constantin-ertel",
    "website":   "https://constiertel.com",
    "github":    "https://github.com/ConstantinVictorBeatErtel",
    "instagram": "https://www.instagram.com/constiertel",
    "twitter":   "https://x.com/ConstantinErtel"
  },
  "images": {
    "linkedin":  "https://media.licdn.com/.../crop_800_800/...",   // 800x800  (primary)
    "github":    "https://avatars.githubusercontent.com/u/129992489?v=4",
    "instagram": "https://.../s320x320/....jpg"                     // 320x320  (fallback)
  },
  "emails": [], "phones": []   // optional, see §5
}
```

---

## The core idea

Two calls cover almost everything, cheaply:
1. **PDL Person Enrich ($0.02)** — the **richest name→data source on Zero**. One call
   returns a full dossier: emails, complete work history, education, skills, social
   profiles, location. This is the data backbone.
2. **LinkedPanda ($0.05)** — supplies the **profile photo** (PDL returns no image) and
   confirms identity; its `about` text often repeats the website + GitHub for free.

GitHub is free/native on top. Everything else (Instagram photo, extra socials, web
photos) is an optional fill-in.

---

## §0. RECOMMENDED DATA BACKBONE — PDL Person Enrich · $0.02/call  ⭐

The single best "name → maximum data" capability we tested. People Data Labs behind
an x402 wrapper.

- **Capability:** `pdl-person-enrich-e8ccbe47`
- **Request:** `POST https://stable-people-data-git-pdl-signoz-usage-alarms-merit-systems.vercel.app/api/pdl/person/enrich`
- **Body (FLAT — do NOT wrap in `{input:{...}}`):**
  `{"name":"<name>","company":"<company>","region":"<state/region>"}`
  PDL needs `name` **plus at least one** qualifier (company, region, school,
  location, email, or a LinkedIn id). With a bare name it 400s (and still charges).
- **Latency:** ~2.3 s · ★4.2 (most-reviewed enricher)

**What one $0.02 call returned for our target (verified):**
- Identity: full name, sex, `linkedin_id/url/username`, `github_url/username`
- **`work_email`** (`constantinertel@berkeley.edu`) + `emails[]`
- Current role + `job_company_*` (name, website, size, industry, address, geo)
- **Full `experience[]`** — every past employer with title, dates, company metadata
  (Wells Fargo ×2, HY Consulting Berlin, Courtyard Ventures…)
- **Full `education[]`** — schools, degrees, majors, **GPAs**, dates
- `skills[]` (17), `industry`, `location_*` (+ lat/long), `street_addresses[]`
- `profiles[]` — normalized social handles (linkedin, github)

The only thing it does **not** return is a profile photo → pair with §1 (LinkedPanda)
or §2 (GitHub avatar) for the image.

> **Gotcha that costs money:** the `zero get` schema shows an `{input:{type,method,
> bodyType,body}}` envelope. That's *descriptive* — send the **flat body**. Sending
> the envelope returns a 400 from PDL and **still charges $0.02**. Same lesson bit us
> on Minerva (needs flat body + a `record_id` per record).

---

## §0b. Enricher shootout (tested live, 2026-07-17)

| Capability | Cost | Result on our target | Verdict |
|---|---|---|---|
| **PDL Person Enrich** ⭐ | $0.02 | Full dossier: emails, work history, education+GPA, skills, socials, location | **Winner** — richest & cheapest |
| Minerva Enrich | $0.05 | Call OK but `is_match:false` (all null) | US-consumer DB (income/wealth/relatives) — misses young/international people |
| OneShotAgent Person Research | $0.05 | 202 "job queued", **no retrievable result** via Zero | Skip until a result-fetch capability exists |
| AnyAPI Social Finder | $0.021 | Social URLs across 13 networks | Good for *handles*, not deep data |
| LinkedPanda Lookup | $0.05 | Photo (800×800) + identity + website/GitHub in `about` | Best for the **photo** |

Other untested-but-promising rich enrichers if you want redundancy: **Apollo Bulk
People Enrichment** ($0.008–0.043, ★4.0, 275M contacts, up to 10/call — good for
*batch*), **Diffbot KG Enhance** ($0.03, knowledge-graph breadth). Both take
name+company or a LinkedIn URL.

---

## The core idea (photo path)

**One LinkedIn call gives the photo, and GitHub is free.** LinkedPanda returns
the photo, identity, *and* usually the personal website + GitHub inside its `about`
text. Parse that first; only pay for discovery/enrichment on fields it didn't give
you.

---

## §1. PRIMARY — LinkedIn: LinkedPanda Profile Lookup · $0.05/call

- **Capability:** `api-linkedpanda-com-13104240`
- **Request:** `GET https://api.linkedpanda.com/agent/v1/profiles/<linkedinUsername>`
- **Latency:** ~3.5 s · **healthy**

Yields in a single call:
- `avatarUrl` — **800×800** LinkedIn photo (primary image)
- `firstName`, `lastName`, `headline`, `title`, `companyName`, `location` — identity + validation
- `about` — free-text bio that **frequently contains the personal website and GitHub**.
  Our target's `about` literally read:
  `"Website: constiertel.com\nGithub: github.com/ConstantinVictorBeatErtel ..."`

**➜ Parse `about` for URLs** (regex for `https?://…`, bare domains, and
`github.com/<user>`) before making any other call. This is a free source of the
website + GitHub links.

---

## §2. GitHub — use the FREE public API, not Zero

Once you have a GitHub username (from §1's `about`, or §3 discovery), call GitHub's
public REST API directly. **It's free and you can call it natively — do not pay Zero
for this.**

```
GET https://api.github.com/users/<login>
```
Returns (verified live): `name`, `avatar_url`, `bio`, **`blog`** (personal website),
`company`, `location`, `twitter_username`, `public_repos`, `html_url`.
Repos: `GET https://api.github.com/users/<login>/repos?sort=updated`.

- **Rate limit:** 60 req/hr unauthenticated; **5,000/hr** with a free personal-access
  token (`Authorization: Bearer <token>`). For a hackathon batch, add a token.
- **When to use Zero's GitHub caps instead:** only if you specifically want the call
  inside the same x402 billing/audit trail, or you're hitting rate limits without a
  token. Cheapest is **AnyAPI GitHub User** (`anyapi-...`, `$0.002`, POST
  `{"handle":"<login>"}`); repo lists via **2s.io GitHub Repository Lister**
  (`$0.001`). Otherwise skip — native is free and identical data.

GitHub's `avatar_url` is also a clean, non-expiring profile image — a good secondary
photo that's always available whenever the person has a GitHub.

---

## §3. Social discovery — AnyAPI Social Finder · $0.021/call

Use **only when §1's `about` didn't reveal the handles you need** (GitHub, Instagram,
Twitter, etc.).

- **Capability:** `anyapi-social-finder-25dfd848`
- **Request:** `POST https://api.getanyapi.com/v1/run/social.finder`
  body `{"name":"<recruitName>","limit":10}` (optionally `"platform":"github"` to
  scope to one network; billed per result, so lower `limit` = cheaper)
- **Latency:** ~38 s (slow)
- **Returns** `output.data.items[]` = `{ social, socialProfileUrl }` across up to 13
  networks: askfm, discord, facebook, github, instagram, linkedin, medium, pinterest,
  steam, threads, tiktok, twitch, youtube.
- **Caveat:** matching is fuzzy — for our target it nailed github/instagram/linkedin
  but returned an **unrelated** Facebook profile. Validate every URL against the
  identity from §1 (name/username overlap) before trusting it.

---

## §4. Instagram — image fallback + bio: AnyAPI IG Search ($0.002) → HireScrape ($0.00225)

Only if you still need an Instagram photo (LinkedIn photo missing) or want the IG bio
(which often also contains the personal website).

- **4a. AnyAPI Instagram Search Profiles** — `anyapi-instagram-search-profiles-2ff8b8c7`,
  POST `{"query":"<recruitName>"}` → `profiles[]` with `handle`, `displayName`, `bio`,
  `avatarUrl` (150×150), `private`. Match by `displayName`/`bio` vs `recruitName`.
- **4b. HireScrape** (optional, higher-res) — `hirescrape-instagram-scraper`, POST
  `{"mode":"profile","handle":"<igHandle>"}` → `items[0].profile_image_link` (320×320).
- **Private accounts:** profile picture + bio still returned; only posts/reels are
  blocked. Good enough for a profile image.

---

## §5. OPTIONAL enrichment add-ons

| Need | Capability | Cost | Notes |
|---|---|---|---|
| Emails / phones / more social links from the personal website | **Contact Extractor** `agents.dyoeway.org/contacts` | $0.01 | GET, pass the website URL; scrapes contact info + social links off the site |
| One-call broad web presence (KG: employment, socials, images, aliases) | **Diffbot KG Enhance** `diffbot-kg.mpp.paywithlocus.com` | $0.03 (0.12 w/ refresh) | POST `{"type":"Person","name":"...","url":"..."}`; heavyweight alternative if you'd rather one rich call than orchestrate §1–4 |
| Contact info (email/phone/social) from the LinkedIn URL | **StableEnrich Clado Contacts Enrichment** | $0.20 | ★3.5; pricier, LinkedIn-URL or email input |
| Extra photos from the open web (news, conf pages, GitHub, etc.) | **People Image Search** `stableenrich-dev-...` | $0.04 | name → Google-image results across all platforms; tier-3 catch-all when the 3 avatars aren't enough |

---

## Control flow

```
enrich(linkedinUsername, recruitName):
  out = { links:{}, images:{}, emails:[], phones:[] }

  # §1 LinkedIn — one call, lots of data
  lp = GET linkedpanda /profiles/{linkedinUsername}          # $0.05
  if lp.ok:
      out.name, out.headline, out.company, out.location = lp.*
      out.links.linkedin = lp.linkedinUrl
      if lp.avatarUrl: out.images.linkedin = lp.avatarUrl     # 800x800
      for url in extractUrls(lp.about):                       # FREE bonus links
          classify(url) -> out.links.website / .github / ...

  # §2 GitHub — FREE native, if we have (or discovered) a login
  ghLogin = out.links.github ? slug(out.links.github) : null
  if not ghLogin and needDiscovery:
      # §3 discovery only if handles still missing
      sf = POST anyapi social.finder {name:recruitName}       # $0.021
      merge validated sf.items into out.links
      ghLogin = slug(out.links.github)
  if ghLogin:
      gh = GET api.github.com/users/{ghLogin}                 # $0 (native)
      out.images.github = gh.avatar_url
      out.links.website ||= gh.blog
      out.links.twitter ||= "https://x.com/"+gh.twitter_username

  # §4 Instagram — only if we still lack a photo or want IG
  if not out.images.linkedin or wantInstagram:
      ig = POST anyapi instagram.search_profiles {query:recruitName}  # $0.002
      cand = bestMatch(ig.profiles, recruitName)
      if cand:
          out.links.instagram = "instagram.com/"+cand.handle
          hs = POST hirescrape {mode:"profile",handle:cand.handle}    # $0.00225 (optional)
          out.images.instagram = hs.profile_image_link or cand.avatarUrl
          out.links.website ||= extractUrls(cand.bio)

  # §5 optional: Contact Extractor on out.links.website, Diffbot for breadth, etc.
  return out
```

`extractUrls` + `bestMatch` reuse the normalize-and-token-match rule from the photo
pipeline (lowercase, strip diacritics/emoji, require both name tokens). Validate
every discovered URL against §1 identity before trusting it.

---

## Cost per recruit

| Scenario | Calls | Cost |
|---|---|---|
| LinkedIn hit, website+GitHub in `about`, GitHub avatar (native) | LinkedPanda + free GitHub | **$0.05** |
| + social discovery (handles not in `about`) | + AnyAPI Social Finder | **$0.071** |
| + Instagram photo | + AnyAPI IG (+ HireScrape) | **+$0.002 (+$0.00225)** |
| + website contact extraction | + Contact Extractor | **+$0.01** |
| Full breadth via one call instead | Diffbot KG Enhance | **$0.03–0.12** |

Typical fully-enriched recruit lands around **$0.07–0.09**. 1,000 recruits ≈ $70–90.
GitHub being free keeps this well under a naive "pay for every field" design.

---

## Gotchas (verified)

- **GitHub: don't pay for it.** Native API is free (60/hr, or 5k/hr with a token) and
  returns the same fields as the $0.002–0.054 Zero caps.
- **Parse LinkedIn `about` first** — website + GitHub are often already there, free.
- **LinkedIn photo URLs are signed and expire** (`e=` param). Download & re-host the
  bytes immediately; don't persist the URL. (GitHub avatar URLs don't expire.)
- **Social Finder is fuzzy and slow** (~38 s, one wrong Facebook match in testing) —
  validate URLs against §1 identity.
- **Some endpoints charge on failure** (HireScrape, StableSocial). Send correct params
  once; this pipeline uses only their reliable modes.
- **Instagram private accounts** still expose profile pic + bio; posts are blocked.
- **AnyAPI bills per result** — keep `limit` low on Social Finder / IG search.

---

## Exact CLI calls (copy-paste)

```bash
Z="$HOME/.zero/runtime/bin/zero"   # or plain `zero` if on PATH

# §1 LinkedIn (photo + identity + website/github in about)
$Z fetch "https://api.linkedpanda.com/agent/v1/profiles/constantin-ertel" \
  --capability api-linkedpanda-com-13104240 --max-pay 0.08 --timeout 120 --json

# §2 GitHub — FREE, native (no zero, no charge)
curl -s "https://api.github.com/users/ConstantinVictorBeatErtel"

# §3 Social discovery by name (only if handles missing)
$Z fetch https://api.getanyapi.com/v1/run/social.finder \
  --capability anyapi-social-finder-25dfd848 --max-pay 0.05 --timeout 120 \
  -d '{"name":"Constantin Ertel","limit":10}' -H "Content-Type:application/json" --json

# §4 Instagram photo fallback
$Z fetch https://api.getanyapi.com/v1/run/instagram.search_profiles \
  --capability anyapi-instagram-search-profiles-2ff8b8c7 --max-pay 0.05 --timeout 120 \
  -d '{"query":"Constantin Ertel"}' -H "Content-Type:application/json" --json
$Z fetch https://hirescrape.com/api/tools/instagram \
  --capability hirescrape-instagram-scraper --max-pay 0.05 --timeout 120 \
  -d '{"mode":"profile","handle":"constiertel"}' -H "Content-Type:application/json" --json
```

Check `.ok` (not `.status`), read `.body`, pass `--capability` every call, and
`zero review <runId>` after each paid call.

---

## Compliance note
This aggregates a real, identifiable person's photos, PII, and web presence. Keep
usage within each platform's ToS and applicable privacy law (GDPR / CCPA; BIPA if
images ever hit face recognition). Store only what the recruiting workflow needs and
honor deletion requests.
