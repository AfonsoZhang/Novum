# Rebuttal-guidance completeness checklist

Check each item before reporting completion.

## Coverage

| # | Check | Pass |
|---|---|---|
| 1 | Every supplied W/Q has a corresponding guidance block and priority tier (`Score-Moving / Fixable / Minor`) | ☐ |
| 2 | Every concern has a type | ☐ |
| 3 | Matched mindset cluster, confidence, and hidden acceptance gate are recorded | ☐ |
| 4 | Recommended strategy dimensions are identified for each concern | ☐ |
| 5 | No experimental numbers are fabricated; unverified values carry [TO VERIFY] | ☐ |
| 6 | Clarifications, zero-cost offline re-analyses, and new experiments are distinguished | ☐ |
| 7 | Every reviewer-cited reference number or paper is verified against `.aux`/`.bbl` or source text | ☐ |
| 8 | Defensive wording is flagged in tone guidance | ☐ |
| 9 | High-overpromise_risk entries identify the relevant risk | ☐ |
| 10 | **Double-blind anonymity:** no identifying links, repository names, or author identities | ☐ |
| 11 | **No-new-paper smuggling:** no unreviewed major methods/theorems introduced beyond clarifications and requested controls | ☐ |
| 12 | **Venue character/word cap (when drafting):** verified under LF (`\n`), CRLF (`\r\n`), and **UTF-8 byte** counts (with safety margin for multi-byte Unicode symbols); when compressing, explicitly list any deleted content words/qualifiers instead of claiming "filler-only" trims | ☐ |
| 13 | **Multi-round discussion anticipation (interactive venues ONLY, e.g., ICLR / NeurIPS; skip for single-round venues):** 1–2 likely follow-up questions noted for open reviewers | ☐ |
| 14 | **Universal-quantifier audit:** never claim "All ... are significant" for a test family containing inconclusive or zero-crossing cells; scope explicitly to the exact significant subset (e.g., "Key multiplicity-adjusted contrasts: [model/condition A] and [interaction B]") | ☐ |
| 15 | **Post-edit compound-clause audit:** after any rewrite or length compression, re-check that *every* clause of each compound weakness/question is still explicitly answered | ☐ |

## Tone issues to flag

- "You misunderstood / You missed / This is trivial": accusatory; revise.
- "Significantly / clearly / undoubtedly": unsupported without relevant evidence.
- "All ... are significant" (when any cell in the family is inconclusive or includes zero): overclaiming; scope to the exact significant subset.
- "We will fully address in future work": evasive when no current action supports it.
- Excessive apologies such as "We sincerely apologize for...": weaken the argument.

## Reviewers with low openness

If the matched mindset's historical score-increase rate is < 15% in mindset-library.md:

- Explain that wording alone has limited support in that historical sample; prioritize
  a decisive new experiment when appropriate.
- Target clarification of the central misunderstanding plus minimal credible evidence.
- Favor concise, substantive responses over an unnecessarily long rebuttal.

## Common mistakes

| Pattern | Example | Correction |
|---|---|---|
| Overlong clarification | 5 paragraphs on an evidence_gap without new data | Compress to 2 sentences and point to the new result |
| Blanket concession | Excessive retreat on a scope_claim | State why the contribution remains valid within the justified scope |
| Evading novelty | Answering limited novelty with greater practicality alone | Identify concrete technical differences from the closest work |
| Treating Questions as Weaknesses | A long defense instead of an answer | Usually 2–3 sentences plus a source pointer |
