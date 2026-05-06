# License

Textral is licensed under the **Elastic License 2.0** (ELv2). The full,
verbatim license text appears below.

> **Copyright (c) 2026 [YOUR ORGANIZATION NAME]. All rights reserved.**
>
> Replace `[YOUR ORGANIZATION NAME]` with your registered legal entity
> before publishing. Replace the contact line in §3 with your real
> licensing inquiries address.

---

## 1. In plain English

The legal text below is what governs. This summary is informal; if it
conflicts with the legal text, the legal text wins.

### What you may do

- **Use** Textral in production, internally, for any purpose within
  your organization.
- **Modify** the source code freely.
- **Distribute** modified or unmodified copies to others.
- **Build commercial products on top of Textral**, provided Textral
  itself is not the product you offer as a service. (e.g., a
  consultancy that uses Textral to build private RAG systems for
  clients is fine; reselling "Textral hosted by us" is not.)

### What you may not do

- **Offer Textral, or a substantially-equivalent fork, to third
  parties as a hosted, managed, or SaaS service.** This is the load-bearing
  protection — it prevents a competitor from cloning the repo and
  selling Textral-as-a-Service.
- **Remove or modify any license-key or licensing-enforcement
  functionality** that we add.
- **Strip or obscure copyright, licensing, or attribution notices.**

### Termination

If you violate the license, your rights end automatically. If we
notify you and you cure the violation within 30 days, the license is
reinstated retroactively. Repeat violations terminate the license
permanently.

### No warranty

The software is provided "as is." We're not liable for damages from
its use, to the maximum extent the law allows.

---

## 2. Why ELv2 and not [permissive license / GPL / proprietary]?

| Option | Why we passed |
|---|---|
| **MIT / Apache 2.0** | Permissive. Anyone can fork Textral and offer it as a paid hosted service in direct competition. Eliminates monetization optionality. |
| **AGPL** | Strong copyleft, but the SaaS workaround (running it as a hosted service without distributing modified source) is hotly contested and varies by jurisdiction. ELv2 explicitly closes the SaaS-hosting loophole. |
| **Proprietary / closed source** | Defeats the goal of public source for community visibility, contribution, and trust. |
| **BSL 1.1** | Also a strong fit. Each version auto-converts to Apache 2.0 after a configurable delay (e.g., 4 years), which can be friendlier to community comfort but reduces long-term protection. ELv2 stays protective indefinitely. |

ELv2 is industry-recognized (Elastic, Sentry pre-2023, Redis) and
permits exactly the use cases we want to permit (internal use,
modification, building products on top) while preventing the one we
don't (Textral-as-a-Service competitors).

---

## 3. Commercial licensing

If you want to offer Textral or a Textral-derived service to third
parties — managed hosting, white-labeled SaaS, embedded in a product
you sell where Textral's functionality is the value being sold —
you'll need a commercial license from us.

Contact: **[licensing@your-org.example.com]**

We're open to conversation; reach out before you build, not after.

---

## 4. Disclaimer

This `LICENSE.md` reproduces the canonical ELv2 text verbatim, but
the file as a whole — including the framing, the in-plain-English
summary, and the contact information — has not been reviewed by
counsel for this specific repository. Before publishing the
repository publicly, especially given monetization intent, we
strongly recommend:

1. **Review with your attorney.** Confirm ELv2 fits your jurisdiction
   and product strategy. Confirm the legal entity name, contact
   address, and copyright assignment.
2. **Decide on a Contributor License Agreement (CLA) or Developer
   Certificate of Origin (DCO).** Public repos that accept outside
   contributions need one of these to ensure you can re-license
   contributions in the future. Without it, every external commit
   becomes a future-relicensing block.
3. **Add a `NOTICE` file** if you redistribute third-party components
   under their own licenses (Apache 2.0 dependencies in particular
   require attribution). A simple audit of `pnpm licenses list` and
   `pip licenses` (for the ingest container) at publish time is
   worth the 30 minutes.
4. **Add a license header to source files** (recommended but not
   required). One option: add `LICENSE-HEADER` comment block in each
   `.ts` / `.py` file pointing at `LICENSE.md`. Tooling like
   `addlicense` can do this in a single pass.

---

## 5. Trademarks

"Textral" and any associated logos are trademarks of
**[YOUR ORGANIZATION NAME]**. The license below grants no rights to
the trademarks. Forks must use a different name.

---

## 6. The license text — Elastic License 2.0

The text below is reproduced verbatim from
<https://www.elastic.co/licensing/elastic-license>. Do not modify it.

```
Elastic License 2.0

URL: https://www.elastic.co/licensing/elastic-license

Acceptance

By using the software, you agree to all of the terms and conditions below.

Copyright License

The licensor grants you a non-exclusive, royalty-free, worldwide,
non-sublicensable, non-transferable license to use, copy, distribute,
make available, and prepare derivative works of the software, in each
case subject to the limitations and conditions below.

Limitations

You may not provide the software to third parties as a hosted or managed
service, where the service provides users with access to any substantial set
of the features or functionality of the software.

You may not move, change, disable, or circumvent the license key
functionality in the software, and you may not remove or obscure any
functionality in the software that is protected by the license key.

You may not alter, remove, or obscure any licensing, copyright, or other
notices of the licensor in the software. Any use of the licensor's
trademarks is subject to applicable law.

Patents

The licensor grants you a license, under any patent claims the licensor can
license, or becomes able to license, to make, have made, use, sell, offer
for sale, import and have imported the software, in each case subject to
the limitations and conditions in this license. This license does not cover
any patent claims that you cause to be infringed by modifications or
additions to the software. If you or your company make any written claim
that the software infringes or contributes to infringement of any patent,
your patent license for the software granted under these terms ends
immediately. If your company makes such a claim, your patent license ends
immediately for work on behalf of your company.

Notices

You must ensure that anyone who gets a copy of any part of the software
from you also gets a copy of these terms.

If you modify the software, you must include in any modified copies of the
software prominent notices stating that you have modified the software.

No Other Rights

These terms do not imply any licenses other than those expressly granted in
these terms.

Termination

If you use the software in violation of these terms, such use is not
licensed, and your licenses will automatically terminate. If the licensor
provides you with a notice of your violation, and you cease all violation
of this license no later than 30 days after you receive that notice, your
licenses will be reinstated retroactively. However, if you violate these
terms after such reinstatement, any additional violation of these terms
will cause your licenses to terminate automatically and permanently.

No Liability

*As far as the law allows, the software comes as is, without any warranty
or condition, and the licensor will not be liable to you for any damages
arising out of these terms or the use or nature of the software, under any
kind of legal claim.*

Definitions

The "licensor" is the entity offering these terms, and the "software" is
the software the licensor makes available under these terms, including any
portion of it.

"you" refers to the individual or entity agreeing to these terms.

"your company" is any legal entity, sole proprietorship, or other kind of
organization that you work for, plus all organizations that have control
over, are under the control of, or are under common control with that
organization. "control" means ownership of substantially all the assets of
an entity, or the power to direct its management and policies by vote,
contract, or otherwise. Control can be direct or indirect.

"your licenses" are all the licenses granted to you for the software under
these terms.

"use" means anything you do with the software requiring one of your
licenses.

"trademark" means trademarks, service marks, and similar rights.
```
