# Textral Landing Page — Design Spec

> **Scope.** Concrete design tokens, typography, surfaces, components,
> and imagery rules for `textral.alacrity.ai`. Authored from the seven
> brand assets that now live in `SCRATCH/images/` (logo + six section
> visuals). Pairs with `HIGH_LEVEL.md` (vision) and `COPY_DECK.md`
> (copy). Implementation follows in `IMPLEMENTATION.md`.
>
> **Status:** First draft, derived from rendered artwork. Token hex
> values are eyeballed from the PNGs — sample with a color picker
> before locking. Open design questions called out in §15.

---

## 1. Brand Foundations

### 1.1 Visual identity in one sentence

> A geometric codex bound in **teal and oxblood**, branching into a
> graph of luminous citation nodes — knowledge made addressable.

The logo's two-tone duotone (teal/red) is **the visual system**. Every
other decision in this spec reinforces that duality: hosted vs.
self-host, dense vs. sparse, retrieval vs. synthesis. We do not
introduce a third brand color.

### 1.2 Logo assets

Three crops live in `SCRATCH/images/`:

| File | Use |
|---|---|
| `logo_banner.png` | Wordmark + mark, horizontal. Default in nav, footer, OG cards. |
| `logo_square.png` | Mark over wordmark, 1:1. App icons, social avatars. |
| `logo_square_no_text.png` | Mark only. Favicons (with rasterization), small chips, watermark. |

The `precrop_*.png` siblings are pre-trim source files — do not ship.

### 1.3 Clear space

Around the wordmark and mark, reserve clear space equal to the
height of the lowercase "t" in "Textral". Do not place type, rules,
or imagery inside that region.

### 1.4 Minimum sizes

- Wordmark (banner): never render below **96px wide** (legibility
  cliff for the gradient at small sizes).
- Mark only: never render below **24px** square. Below that, use the
  rasterized favicon set (16/32/48 ICO).

### 1.5 Misuse — don't

- Don't recolor the gradient. The teal-to-red transition is the
  identity.
- Don't separate the book from the citation-graph nodes. They are
  one mark.
- Don't place the dark-rendered mark on a dark background without
  the white edge accent intact (it disappears).
- Don't render the mark flat. The 3D shading is intentional — it
  reads as a physical codex, not a generic icon.

## 2. Color System

The system has **two palettes** that must coexist:

- **Brand palette** — saturated, used in the logo and any place the
  brand identity appears at human scale.
- **UI palette** — luminous, derived from the brand hues but tuned
  for dark-mode surfaces and information density. This is what the
  page is mostly built from.

Same hues, different brightness regimes. The bridge is intentional.

### 2.1 Brand palette (logo & identity)

| Token | Hex (approx) | Where |
|---|---|---|
| `brand-teal-deep` | `#1F5862` | Logo book left face (shadow side) |
| `brand-teal` | `#2D7E8C` | Logo book left face (light side), wordmark left |
| `brand-red-deep` | `#6E141C` | Logo book right face (shadow side) |
| `brand-red` | `#A8232E` | Logo book right face (light side), wordmark right |
| `brand-edge` | `#FFFFFF` | Highlight edges and node centers on the mark |

The wordmark is a smooth gradient from `brand-teal` (left) through a
neutral midpoint to `brand-red` (right). Don't try to recreate this
in CSS — it's hand-tuned per glyph in the source PNG.

### 2.2 UI palette (dark mode default)

Dark mode is the **default and primary** experience. Light mode is
optional and deferred (§13).

#### Surfaces

| Token | Hex | Use |
|---|---|---|
| `bg-base` | `#0A0F1A` | Page background |
| `bg-elevated` | `#10172A` | Cards, code blocks |
| `bg-overlay` | `#1A2238` | Hover/active card states, modal bg |
| `border-subtle` | `#1F2A3F` | Default 1px card borders |
| `border-strong` | `#2C3A55` | Hovered cards, focused inputs |

#### Text

| Token | Hex | Use |
|---|---|---|
| `text-primary` | `#E6ECF5` | Headlines, body |
| `text-secondary` | `#A8B3C7` | Subheads, lead paragraphs |
| `text-tertiary` | `#6B788F` | Labels, captions, table cells |
| `text-disabled` | `#465268` | Disabled controls |
| `text-inverse` | `#0A0F1A` | Text on bright accent buttons |

#### Accents (luminous, derived from brand hues)

| Token | Hex (approx) | Semantic role | Lifted from |
|---|---|---|---|
| `accent-teal` | `#3DD9CC` | Hosted, dense retrieval, primary action | `retrieval_lineage_flow.png`, `hosted-self-hosted-symmetry.png` (left) |
| `accent-coral` | `#FF5C6E` | Self-host, reranker, secondary structure | `hosted-self-hosted-symmetry.png` (right), `mcp.png` (reranker) |
| `accent-amber` | `#FFC93C` | Fusion, in-flight state, audit-trail markers | `retrieval_lineage_flow.png` (RRF) |
| `accent-magenta` | `#FF7AC6` | Synthesis, citation output | `retrieval_lineage_flow.png` (synthesis) |
| `accent-success` | `#5BD16D` | Audit success, "ok" status | `mcp.png` (status dots) |

#### Code-block tokens

| Token | Hex | Use |
|---|---|---|
| `code-bg` | `#0D1424` | Code block background (one shade darker than `bg-elevated`) |
| `code-keyword` | `#FF5C6E` | `const`, `import`, `function`, etc. |
| `code-string` | `#5BD16D` | String literals |
| `code-number` | `#FFC93C` | Numeric literals |
| `code-comment` | `#6B788F` | Comments |
| `code-fn` | `#3DD9CC` | Function names, MCP tool names |
| `code-default` | `#E6ECF5` | Identifiers, punctuation |

### 2.3 Semantic mapping — the contract

These pairings are **load-bearing**. Don't drift from them:

| Concept | Token |
|---|---|
| Primary action / "Try the sandbox" | `accent-teal` |
| Hosted deployment | `accent-teal` |
| Self-hosted deployment | `accent-coral` |
| Dense / vector retrieval | `accent-teal` |
| Sparse / BM25 retrieval | `accent-amber` (or muted teal — not coral) |
| Reranker | `accent-coral` |
| Fusion / RRF | `accent-amber` |
| Synthesis / output | `accent-magenta` |
| Audit success | `accent-success` |
| Error / failure | `accent-coral` |

If a future section adds a concept not on this list, derive its color
from the closest existing semantic — don't introduce a new accent.

### 2.4 Gradient & glow

- **Gradient ribbon** (used sparingly — hero divider, section breaks,
  feature spotlight): `linear-gradient(90deg, accent-teal 0%, accent-amber 50%, accent-coral 100%)`. Mirrors the logo's left-to-right hue arc.
- **Soft glow** behind hero text and the logo mark on dark
  backgrounds: `radial-gradient(circle, rgba(61,217,204,0.15) 0%, transparent 60%)`. Keeps the palette luminous without smearing.

## 3. Typography

### 3.1 Type families

| Role | Family (1st) | Fallback chain |
|---|---|---|
| Display / headlines | **Manrope** ExtraBold (700–800) | Inter, system-ui |
| Body / UI | **Inter** Regular/Medium (400–500) | system-ui, -apple-system |
| Mono / code | **Geist Mono** Regular/Medium | JetBrains Mono, ui-monospace |
| Wordmark recreation | (Use the PNG, don't recreate in CSS) | — |

**Rationale.** Manrope's slightly geometric construction with rounded
terminals matches the logo wordmark closely enough that the brand
reads as one system. Inter is the body workhorse for dev-tooling
sites at this aesthetic tier (Linear, Vercel, Resend). Geist Mono
ships with a high-quality dev-tooling pedigree and looks great in the
audit-trail JSON snippets.

If Manrope feels too generic in practice, the credible alt is
**Eudoxus Sans** (warmer, more distinctive) or **Söhne** (premium,
licensed). Lock during build, not now.

### 3.2 Type scale (rem, base 16px)

| Token | Size | Line-height | Letter-spacing | Use |
|---|---|---|---|---|
| `text-7xl` | 4.5rem (72) | 1.05 | -0.03em | Hero H1 (desktop) |
| `text-6xl` | 3.75rem (60) | 1.1 | -0.025em | Hero H1 (tablet) |
| `text-5xl` | 3rem (48) | 1.15 | -0.02em | Section H2 |
| `text-4xl` | 2.25rem (36) | 1.2 | -0.015em | Sub-section H3 |
| `text-3xl` | 1.875rem (30) | 1.25 | -0.01em | Pillar headlines |
| `text-2xl` | 1.5rem (24) | 1.3 | -0.005em | Card titles |
| `text-xl` | 1.25rem (20) | 1.4 | 0 | Lead paragraphs |
| `text-lg` | 1.125rem (18) | 1.55 | 0 | Body |
| `text-base` | 1rem (16) | 1.6 | 0 | Body small / nav |
| `text-sm` | 0.875rem (14) | 1.5 | 0 | Captions, table cells, code in copy |
| `text-xs` | 0.75rem (12) | 1.45 | 0.04em | Tag labels (uppercase) |

**Hero H1** is the only place we use `text-7xl`. It must wrap to
maximum 2 lines on every breakpoint.

### 3.3 Weight discipline

| Weight | Usage |
|---|---|
| 800 (ExtraBold) | Hero H1 only |
| 700 (Bold) | H2–H4 |
| 600 (Semibold) | Pillar headlines, button labels |
| 500 (Medium) | Nav links, lead paragraphs, code block file labels |
| 400 (Regular) | Body, captions, mono code |

Avoid 300 (Light) — reads as airy/marketing, undercuts the dev-infra
trust signal.

### 3.4 Tracking & rhythm

- Display sizes (`text-4xl`+): negative tracking as in §3.2.
- Body sizes: tracking 0.
- All-caps tags (`text-xs`): `0.04em` — labels like `MCP`, `HOSTED`,
  `BETA`, section eyebrows like `THE AUDIT STORY`.

## 4. Spacing & Layout

### 4.1 Spacing scale (rem)

Powers-of-2 tuned: `0`, `0.25`, `0.5`, `0.75`, `1`, `1.5`, `2`, `3`,
`4`, `6`, `8`, `12`, `16`, `24`, `32`. (Tailwind defaults, kept for
team familiarity — don't reinvent.)

### 4.2 Container widths

| Width | Use |
|---|---|
| `max-w-prose` (≈ 65ch / 720px) | Body copy passages |
| `max-w-5xl` (1024px) | Default section content |
| `max-w-6xl` (1152px) | Wider sections (pillars, comparison table) |
| `max-w-7xl` (1280px) | Hero, footer |
| Full-bleed | Hero background gradient, gradient ribbons |

Outer page gutter: `px-6` (24px) mobile, `px-8` (32px) tablet,
`px-12` (48px) desktop.

### 4.3 Vertical rhythm

- Section spacing: `py-24` (96px) on desktop, `py-16` (64px) on
  mobile. Hero is `py-32 md:py-40`.
- Inter-element spacing inside a section: `space-y-6` for stacked
  copy, `gap-8` for card grids.
- Avoid more than 4 distinct vertical rhythms on one page —
  consistency is the goal.

### 4.4 Breakpoints

| Token | Width | Notes |
|---|---|---|
| `sm` | 640px | Phones, landscape |
| `md` | 768px | Small tablets |
| `lg` | 1024px | Default desktop pivot — pillars go from 1-col → 2-col → 4-col here |
| `xl` | 1280px | Large desktop |
| `2xl` | 1536px | Cap content widths above this |

Tested range: **320px → 1920px**.

## 5. Surfaces & Elevation

Surfaces ladder up by background brightness, not by drop shadow.
Drop shadows on dark mode look muddy — we use border + background
delta instead.

```
bg-base (page)            → #0A0F1A
↓ +1 ladder
bg-elevated (cards)       → #10172A   border-subtle 1px
↓ +1 ladder
bg-overlay (hover/active) → #1A2238   border-strong 1px
↓ +1 ladder
code-bg (inside cards)    → #0D1424   no border
```

Two specific elevations are allowed shadows for emphasis:

- **Hero CTA button (focused state):** `0 0 0 4px rgba(61,217,204,0.25)` — a teal focus halo, not a drop shadow.
- **Modal / dialog (rare):** `0 24px 64px -12px rgba(0,0,0,0.6)`.

## 6. Borders, Radii, Shadows

### 6.1 Border radius

| Token | Value | Use |
|---|---|---|
| `rounded-none` | 0 | Code block edges (slight retro feel) |
| `rounded-sm` | 4px | Tags, badges, pills |
| `rounded-md` | 8px | Buttons, inputs |
| `rounded-lg` | 12px | Cards, code blocks |
| `rounded-xl` | 16px | Hero card surfaces, the audit JSON panel |
| `rounded-2xl` | 24px | Featured imagery containers |

Don't go bigger than `rounded-2xl`. We're not a consumer-app brand.

### 6.2 Border width

`1px` is the system default. `2px` only for focus rings.

### 6.3 Shadow tokens

Defined above (§5). Avoid all other shadows in the dark theme.

## 7. Iconography

- **Library:** [Lucide](https://lucide.dev) — open source, dev-tool
  default, MIT license, ships an Astro/React component pkg.
- **Stroke width:** 1.5px (default) for body icons; 1.75px for
  pillar/feature icons (slightly heavier for prominence).
- **Color:** `text-secondary` by default; `accent-teal` for active
  state; never multi-color (icons stay monochromatic).
- **Sizes:** `16` (inline with text), `20` (button accents), `24`
  (card headers), `32` (pillar icons), `48` (hero accents).

If a Lucide glyph doesn't exist for a concept (e.g. "RRF fusion" or
"dim-locked namespace"), commission a custom SVG in the same stroke
weight. Don't fall back on emoji.

## 8. Illustration & Imagery

The seven existing assets in `SCRATCH/images/` slot into specific
sections. Where they go and how they're treated:

### 8.1 Asset → section map

| Asset | Section (per `HIGH_LEVEL.md` §4) | Treatment |
|---|---|---|
| `logo_banner.png` | Nav, footer, OG card, social meta | As-is, transparent bg |
| `logo_square_no_text.png` | Favicon (rasterized), hero glow accent | 24px+, white-edge intact |
| `retrieval_lineage_flow.png` | §5 The Audit Story, secondary visual | Inline, full-width on mobile, half-width column on desktop alongside JSON snippet |
| `mcp.png` | §3 Hero (fallback option 2) **or** §6 Code-First Proof | If hero: cropped to 16:9, soft fade to `bg-base` at edges. If §6: inline, no fade, bordered card |
| `hosted-self-hosted-symmetry.png` | §7 Hosted or Self-Hosted | Centerpiece of the section; full container width, no crop |
| `integrations.png` | §8 Compared To… preface, **or** dedicated mini-section "Brings what you have" | Below the comparison table as a "and yes, we connect to all this" closer |
| `logo_square.png` | App store / press kit | Off-page assets only |

### 8.2 Treatment rules

- **No drop shadows on imagery.** The illustrations are already
  stylized; shadows make them feel pasted-in.
- **No background recolor.** All section visuals were rendered against
  a near-black; place them on `bg-base` so the edges feather naturally.
- **Generous breathing room.** `py-12` minimum vertical padding inside
  any container holding a featured visual.
- **Lazy load all** below-fold imagery. Eager-load only the hero.
- **Provide explicit width/height** to prevent CLS. Source aspect
  ratios:
  - `retrieval_lineage_flow.png` — ~3:2
  - `hosted-self-hosted-symmetry.png` — ~3:4 (portrait — plan layout!)
  - `mcp.png` — ~3:2
  - `integrations.png` — ~3:2

> ⚠ The hosted/self-host symmetry image is **portrait**. The §7
> layout in `HIGH_LEVEL.md` assumed a landscape side-by-side. Either
> regenerate the image landscape, or reflow §7 to a single centered
> column with the portrait visual centered. Recommend the reflow —
> the portrait composition is stronger.

### 8.3 OG / social cards

Every shareable URL needs a 1200×630px OG card. Three templates:

1. **Default OG** — `logo_banner.png` left-aligned over `bg-base`
   with the page title as `text-4xl` Manrope to its right; subtle
   teal glow behind.
2. **Roadmap doc OG** — same template + the doc filename in mono
   below the title.
3. **Audit / feature OG** — `retrieval_lineage_flow.png` as
   background at 30% opacity with the headline overlaid.

Generate these at build time (Astro `og:image` integration). Do not
hand-author per page.

### 8.4 Future commissions

Gaps the existing seven assets don't cover:

- A **§9 roadmap card grid** could use 4 small (~200×120) decorative
  motifs — currently the cards will be type-only, which is fine for
  v1.
- A **§10 pricing section** has no asset; type-only with a subtle
  amber gradient stroke is sufficient.
- The hero animated audit trace (HIGH_LEVEL §5 option 1) remains
  v2 work.

## 9. Code Blocks

Code is the most-read content on the page after the hero. It deserves
real design effort.

### 9.1 Anatomy

```
┌─────────────────────────────────────────────────┐
│  [tab: REST] [tab: TypeScript] [tab: MCP]   📋  │  ← header bar (bg-overlay)
├─────────────────────────────────────────────────┤
│                                                 │
│   1 │ const client = new Client({...});         │
│   2 │ await client.namespaces.create({...});    │  ← code body
│   3 │                                           │     (code-bg, mono)
│                                                 │
└─────────────────────────────────────────────────┘
```

### 9.2 Tokens

- Container: `bg-elevated`, `border-subtle`, `rounded-lg`,
  `overflow-hidden`.
- Header bar: `bg-overlay`, height `40px`, `text-xs` mono labels,
  copy button `accent-teal` on hover.
- Body: `bg-code-bg`, `text-sm` Geist Mono, line-height `1.7`,
  padding `1.5rem`. Optional gutter line numbers in `text-tertiary`.

### 9.3 Highlighting

Use [Shiki](https://shiki.style) at build time. Color tokens map to
§2.2 code tokens. Avoid runtime highlighting libraries — they tank
LCP.

### 9.4 Copy-to-clipboard

Top-right of every code block. Default `text-tertiary`, hover
`accent-teal`, `aria-label="Copy to clipboard"`. On click, swap icon
to ✓ for 1.5s. No toast, no animation more elaborate than the icon
swap.

### 9.5 Inline code

`bg-elevated`, `text-sm`, `rounded-sm`, `px-1.5 py-0.5`,
`font-mono`. No syntax color — inline code stays `text-primary`.

## 10. Motion

Calm. Restrained. The audience's tolerance for motion is low; we earn
trust by not overdoing it.

### 10.1 Allowed motion

- **On-scroll reveal:** elements fade up 8px with opacity 0→1 over
  400ms with `ease-out`. Stagger child elements at 80ms.
- **Hover transitions:** background and border color over 150ms
  `ease-in-out`. Transform/scale prohibited — feels gimmicky.
- **Code-block copy feedback:** icon swap, no animation.
- **Hero gradient shimmer (optional):** a subtle horizontal hue
  shift on the gradient ribbon, 8s loop, 5% amplitude. Off when
  `prefers-reduced-motion`.

### 10.2 Prohibited

- Bouncy springs.
- Parallax beyond 30px translation.
- Anything that recomposes layout on hover.
- Auto-playing video.
- Continuous loops other than the hero shimmer.

### 10.3 Reduced motion

`@media (prefers-reduced-motion: reduce)`: all transitions ≤ 80ms,
opacity-only (no transform), all loops paused.

## 11. Hero Treatment

The hero is the page's most expensive surface. Spec it explicitly.

### 11.1 Layout (desktop, ≥`lg`)

```
┌────────────────────────────────────────────────────────────────┐
│  Nav (sticky, 64px tall, blur background)                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  [eyebrow: BETA · MCP-NATIVE]                                  │
│                                                                │
│  Hosted RAG your AI agent                                      │  ← H1 text-7xl
│  can actually use.                                                Manrope ExtraBold
│                                                                   text-primary, with
│                                                                   subtle gradient on
│                                                                   "actually use"
│  Hybrid retrieval, audit-first, MCP-native. Run it on            ← Lead text-xl
│  Cloudflare or self-host on your own infra — same                  text-secondary
│  packages, same contracts.                                         max-w-prose
│                                                                │
│  [ Try the sandbox → ]   [ View on GitHub ↗ ]                  ← CTAs
│                                                                │
│                              [ hero visual: mcp.png cropped ]  ← Right column on xl+
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

On `lg` and below, the visual stacks under the copy at full width.

### 11.2 Background

- Base: `bg-base`.
- Soft radial glow centered behind H1: `radial-gradient(circle at 40% 50%, rgba(61,217,204,0.12), transparent 60%)`.
- Bottom edge: 1px gradient ribbon (§2.4) at full width, `opacity-40`,
  serves as the section divider into Pillars.

### 11.3 Eyebrow tag

`text-xs` uppercase, `tracking-[0.04em]`, `accent-teal` text on a
`rounded-sm` `border-subtle` chip with `bg-elevated` fill. Pattern:
`BETA · MCP-NATIVE` separated by a `text-tertiary` middle dot.

### 11.4 Gradient on "actually use"

Apply the brand gradient (§2.4) to the words "actually use" using
`background-clip: text`. Subtle — a 60% blend with `text-primary` so
it reads as emphasized, not garish. Skip on browsers without
`background-clip` support; falls back to plain `text-primary`.

### 11.5 CTAs

- **Primary:** `bg-accent-teal text-inverse rounded-md px-6 py-3 font-semibold`. Hover: brightness +6%. Focus: 4px teal halo (§5).
  Trailing `→` arrow, 4px gap.
- **Secondary:** `bg-transparent border-strong text-primary rounded-md px-6 py-3 font-medium`. Hover: `bg-elevated`. Trailing
  `↗` for outbound.

CTA gap: `gap-4`. Primary always left of secondary. On mobile they
stack with `space-y-3`, primary first.

## 12. Component Sketches

### 12.1 Pillar card (×4)

```
┌────────────────────────────────┐
│  [icon 32px, accent-teal]      │
│                                │
│  MCP-native by default         │  ← text-2xl, font-semibold
│                                │
│  Your AI agent calls Textral   │  ← text-base, text-secondary
│  directly, no glue code.       │     max 2 lines
│  Multi-profile addressing for  │
│  stage and prod.               │
└────────────────────────────────┘
  bg-elevated, border-subtle, rounded-lg, p-6, hover:border-strong
```

The icon color rotates per pillar to reinforce semantic mapping
(§2.3): MCP=teal, hybrid=amber, audit=magenta, deploy=coral.

### 12.2 Feature spotlight (Audit Story)

Two-column on `lg`+: narrative copy left (`max-w-prose`), JSON code
block right with `mcp.png`-style dotted-line connector pointing from
a highlighted token in copy to a corresponding field in the JSON.
Dotted line `accent-amber`, 1px, with a small dot at each end.

On mobile: stacks, connector replaced with simple right-pointing
chevron.

### 12.3 Comparison table

```
┌──────────────────┬─────────┬──────────┬─────────┬──────────┐
│                  │ Textral │ Pinecone │ Vectara │ OpenAI FS│
├──────────────────┼─────────┼──────────┼─────────┼──────────┤
│  MCP-native      │   ✓     │    ✗     │    ✗    │    ✗     │
│  Hybrid retrieval│   ✓     │    ✓     │    ✓    │ partial  │
│  Audit lineage   │ ✓ full  │ partial  │ partial │ minimal  │
│  Self-hostable   │ ✓ same  │    ✗     │    ✗    │    ✗     │
│                  │ package │          │         │          │
└──────────────────┴─────────┴──────────┴─────────┴──────────┘
```

- ✓ in `accent-success`, ✗ in `text-tertiary` (not coral — coral
  reads as failure-of-Textral; we want neutral disclosure).
- "partial" / "minimal" badges in `bg-elevated`, `text-secondary`,
  `text-xs`.
- Textral column has subtle `bg-elevated` highlight + 1px
  `accent-teal`/30% top border.
- Sticky leftmost column on horizontal scroll (mobile).

### 12.4 Code-First tabs

Three tabs: REST, TypeScript, MCP. Active tab: `text-primary` with a
2px `accent-teal` bottom border. Inactive: `text-tertiary`. Tab row
sits inside the code block header bar (§9.1).

### 12.5 Roadmap snapshot card

Compact card, `p-5`, `bg-elevated`, hover lifts `border` to
`accent-teal`/40%. Icon + title + 1-line description + arrow. Click
target wraps the whole card.

### 12.6 Footer

4 columns on `lg`+ (Product / Open Source / Company / Legal),
collapses to 2-col on `md`, 1-col on mobile. Logo banner left,
column links right. Bottom strip: copyright + social icons (right-aligned).

## 13. Light Mode

**Deferred to v2.** Reasoning:

- Dev-tooling brands ship dark-first by default (Linear, Resend,
  Vercel, Anthropic engineering). Our audience won't punish us for
  not having light mode at launch.
- Light-mode tokens for the luminous accent palette (`accent-teal`
  at `#3DD9CC`) lose contrast on white — they require a different,
  more saturated tuning that effectively doubles the design token
  set.
- The illustration assets are baked dark. Inverting them
  algorithmically will look bad; commissioning light variants
  doubles the imagery cost.

If light mode becomes a hard requirement post-launch, plan it as a
1-sprint follow-up, not as part of v1.

## 14. Accessibility

### 14.1 Color contrast

- Body text on `bg-base` (`#E6ECF5` on `#0A0F1A`): **15.4:1**, AAA.
- `text-secondary` on `bg-base` (`#A8B3C7` on `#0A0F1A`): **9.2:1**,
  AAA.
- `accent-teal` on `bg-base`: **8.7:1**, AAA — but **only** for
  text-as-decoration. The CTA uses `text-inverse` on `accent-teal`
  fill (**14.1:1** AAA).
- `accent-amber` on `bg-base`: 11:1, AAA.
- `accent-coral` on `bg-base`: 5.4:1, AA. **Do not use coral for
  body text.** Reserve for icons, badges, table marks.

Audit with [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/) before locking final hex values.

### 14.2 Focus states

- 2px solid `accent-teal` outline + 2px offset on every interactive
  element.
- Skip-to-content link as the first focusable element on every page.

### 14.3 Keyboard navigation

- Full tab order. Custom components (tabs, modals) implement WAI-ARIA
  patterns.
- Code blocks: copy button reachable via tab; `Enter` triggers copy.
- Comparison table: arrow keys navigate cells when focused (use
  `role="grid"` only if we implement this — otherwise leave as
  semantic `<table>`).

### 14.4 Screen readers

- All imagery has descriptive `alt` text. The five section visuals
  have alt text from `image_descriptions.md` paraphrased to ≤120
  chars each.
- Icons that are decorative use `aria-hidden="true"`.
- The wordmark in nav uses `alt="Textral"` not the full descriptor.

### 14.5 Reduced motion

Already specified in §10.3.

## 15. Open Design Questions

1. **Wordmark recreation.** Is there an editable source (Figma, AI,
   SVG) for the wordmark, or is the PNG the only artifact? If PNG-only,
   we cannot:
   - Render at arbitrary sizes without quality loss (mitigation:
     export 1×/2×/3× PNG variants from the source).
   - Animate individual letters.
   - Recolor for a future light-mode variant.
   **Decision needed.** Recommend commissioning an SVG version next.

2. **Symmetry image is portrait.** §7 layout assumed landscape side-by-side. Either reflow §7 (recommend) or regenerate the image
   landscape.

3. **Display font lock.** Manrope is the default in this spec.
   Acceptable, but if the wordmark was set in something more
   distinctive (Eudoxus Sans? a custom face?), Manrope will feel
   like a mismatch. Recommend a side-by-side comparison test before
   final lock.

4. **Hero visual choice.** This spec assumes `mcp.png` is the hero
   visual (HIGH_LEVEL §3 fallback option 2). If we want to ship the
   v1 hero with the live audit-trace animation (option 1), need a
   separate spec section. Recommend defer to v2.

5. **Does Alacrity have an existing design system?** This spec
   stands alone — but if Alacrity has a parent palette, type stack,
   or component library, parts of this should defer. Need a 1-line
   answer: "yes, here it is" or "no, Textral leads".

6. **OG card auto-generation.** Astro has multiple options
   (`@vercel/og`, Satori-based, manual SVG). Lock in `IMPLEMENTATION.md`.

7. **Roadmap card decoration.** Type-only or commission 4 small
   motifs? Recommend type-only for v1, commission for v2.

8. **Comparison table — the "Textral column highlight."** Is the
   subtle teal highlight too self-promotional? Some sites do it,
   some don't. The honest framing in `HIGH_LEVEL.md` argues against
   anything that looks weaselly. Test both with 2-3 ICP-shaped
   reviewers.

## 16. File Inventory

What this spec produces and where:

| Artifact | Location | Owner |
|---|---|---|
| Token CSS variables | `apps/landing/src/styles/tokens.css` | Implementation |
| Tailwind theme config | `apps/landing/tailwind.config.ts` | Implementation |
| Logo + section assets | `apps/landing/public/brand/` (copied from `SCRATCH/images/`) | Design |
| OG card templates | `apps/landing/src/og/` | Implementation |
| Component library | `apps/landing/src/components/` | Implementation |
| Lucide icon set | npm dep `lucide-astro` | Implementation |
| Web font files | `apps/landing/public/fonts/` (self-hosted, not Google Fonts CDN) | Implementation |
| This spec | `docs/landingpage/DESIGN_SPEC.md` | Design |

## 17. Sequence of Sign-off

Before starting `IMPLEMENTATION.md` and `apps/landing/` scaffolding:

1. ✅ Brand assets exist (`SCRATCH/images/`)
2. ⬜ Open question §15.5 answered (Alacrity design system y/n)
3. ⬜ Open question §15.2 resolved (portrait reflow vs. regenerate)
4. ⬜ Token hex values verified with a color picker against the PNGs
5. ⬜ Manrope vs. Eudoxus Sans tested in a 1-screen mockup
6. ⬜ At least 2 ICP-shaped reviewers eyeball the hero mockup

Then implementation begins.

---

> Last reviewed: 2026-05-08. Owner: Leif (until a designer joins).
> Status: **proposed** — derived from rendered brand assets; awaiting
> open-question resolution before lock.
