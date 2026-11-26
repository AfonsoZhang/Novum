---
name: ai-use-drafter
description: >-
  Draft a standalone AI-use disclosure for an academic paper from actual usage
  records and author input. Use for AI-use statements, AI use declarations or disclosure
  drafting. Deliver an editable draft for the author; never automatically insert
  it into a manuscript or submission form.
---

# AI-use disclosure draft

Apply the shared [working-language policy](../../../shared-references/research-autonomy.md#working-language) to internal work and user reports.

Help the author describe how AI was actually used. The deliverable is a separate
draft for the user to revise, not a finalized declaration or manuscript edit.

## Output boundary

- Return a clearly labelled draft in chat, or save a separate
  `drafts/ai-use-disclosure.draft.md` within the relevant research work directory
  when a file deliverable is appropriate. Do not infer a paper from an unrelated
  project or write into the skill installation directory.
- Do not modify manuscript text, acknowledgments, appendices, bibliography,
  submission fields, or LaTeX includes/build configuration. Do not add the draft
  to an automatic assembly pipeline. Suggested placement belongs in notes only.
- Leave insertion to the user. A request to generate, revise, or accept a draft
  does not authorize insertion; a later explicit request to insert specific text
  is a separate task.
- Preserve author edits. Read any existing draft first; when producing a new
  version, use a new filename unless asked to revise that existing file.

## Establish the facts

Use the supplied account and relevant, accessible project records. For each actual
use, identify the tool/model (version when known), task, affected material, and
what the author actually reviewed, changed, tested, or retained. Capture dates or
periods when available and relevant. Distinguish AI used as part of the research
method from AI used to assist the research or writing workflow.

Map supported uses to the bundled [GAIDeT tasks](references/gaidet-terms.yml) when
helpful. These categories describe tasks; they do not establish authorship,
policy compliance, human supervision, or whether disclosure is required. Select
only relevant tasks, not an exhaustive checklist in the statement.

- Installed tools are not evidence that they were used for this paper.
- Missing logs do not prove non-use. Keep unknown facts as questions for the
  author; do not guess model versions, task scope, or review actions.
- Distinguish drafting from proofreading, and proposed actions from completed
  actions. Do not reduce substantive AI assistance to language polishing.
- Do not erase historical use merely because the output was subsequently
  rewritten or discarded. Describe its actual role and disposition where needed.
- Do not prefill claims of full human supervision, complete verification,
  exclusively human intellectual contributions, or absence of sensitive data.
  Include such assertions only to the extent the author or records substantiate them.

## Live venue policy retrieval

Whenever a target venue, publisher, or conference year is given (or known from project context) and the user has not already provided the verbatim policy text, **actively retrieve the current official AI-use / LLM policy** before drafting rather than relying on memory:

1. **Search official sources first.** Query the venue's current-year CFP, author guidelines, or publisher policy page (e.g., `"<venue> <year>" ("AI policy" OR "LLM policy" OR "generative AI" OR "AI disclosure")`, or official publisher portals such as ACL/ARR, NeurIPS, ICML, ICLR, IEEE, ACM, Springer Nature, Elsevier, AAAI). Prefer the exact submission year; if the target year is not yet published, check the most recent official edition and flag the year difference.
2. **Extract actionable policy requirements.** Read the official page and record:
   - **Disclosure trigger:** required for all AI use, only beyond grammar/spell-checking, or mandatory even for non-use.
   - **Required placement:** submission form / checklist, dedicated section, Acknowledgments, Methods, Ethics/Reproducibility statement, or appendix.
   - **Required details:** tool/model name and version, specific tasks/sections, prompts or logs, or required wording/checkboxes.
   - **Prohibitions & boundaries:** authorship bans, restrictions on AI-generated figures/references/peer review, or confidentiality rules.
3. **Keep policy metadata out of the declaration.** Record the official URL, policy version/effective year, retrieval date, and mapped requirements in the **Drafting & Policy Notes** section—never inside the declaration prose unless the venue explicitly requires citing its policy.
4. **Honest fallback when offline or unavailable.** If web retrieval is disabled, fails, or yields no official policy for the target venue, do **not** invent or recall venue rules from memory. Draft from the general template below and explicitly mark `Venue policy status: UNVERIFIED (live lookup unavailable or no official policy found)`. Do not upload project records to any website.

## General disclosure template

When no venue-specific wording is prescribed (or as the base structure before adapting to a retrieved venue policy), use this concise, editable generic template. Fill only facts confirmed by the author or project records, and keep every unconfirmed slot as an explicit `[PLACEHOLDER]`:

### English general template (default for English manuscripts)

```text
[Optional — only if AI was used as part of the research workflow]
During the preparation of this work, the authors used [TOOL/MODEL NAME, VERSION if known]
for [SPECIFIC ACTIONS, e.g., grammar and clarity checking in Section X / generating Python
scripts for log parsing / translating draft notes in Section Y]. The authors reviewed,
edited, and verified [SPECIFIC OUTPUTS / CODE / TEXT] and take full responsibility for
the content of the manuscript.

[Optional — include only when AI was also used as an experimental or methodological component]
Separately from writing or workflow assistance, [MODEL/SYSTEM NAME, VERSION] was used as
part of the research methodology as described in Section [X].
```

*(If the author confirms no generative AI was used and the target venue requires an explicit negative declaration: `No generative AI tools were used in the preparation of this manuscript.`)*

### Chinese general template (for Chinese manuscripts)

```text
[仅在研究或写作流程中实际使用了 AI 工具时保留]
在本文的研究与撰写过程中，作者使用了 [工具/模型名称及已知版本]，具体用于 [具体任务与涉及范围，例如：第 X 节的语法与表达润色 / 实验日志解析脚本编写 / 文献初筛]。作者已对相关 [文本/代码/输出] 进行了人工复核、修改与验证，并对本文内容承担全部责任。

[如模型同时作为研究方法或实验对象，单独区分说明]
此外，作为研究方法与实验组成部分的 [模型/系统名称及版本] 已在正文第 [X] 节中单独说明。
```

## Draft and hand back

Use the paper's language and requested length. Adapt the general template (or the retrieved venue format) into a concise natural paragraph from known facts, with additional detail only when necessary or requested. Do not require both short and long versions unless asked.

Describe specific actions and the material affected. Avoid umbrella phrases such as "manuscript preparation", "writing assistance", "research support", or "improving quality" as descriptions of AI use. A tool name or task-category label alone is not an adequate account of what it did.

For example, when supported by actual records, write "corrected grammar in the Abstract and Discussion", "drafted the first version of the Related Work section", or "generated Python code for parsing evaluation logs". These are wording examples, not facts to prefill. State which tasks actually occurred; distinguish text generation, language correction, translation, literature retrieval, code generation, and data analysis where relevant. Specify the scope without inventing section names, coverage, or author verification actions.

When the task or scope is unknown, leave a precise question or placeholder for the author instead of concealing the gap with a broad phrase. Greater specificity must not turn substantive AI contributions into a claim of proofreading only.

Present the deliverable in three clearly separated blocks:
1. **Editable AI-Use Disclosure Draft** (ready for the author to revise and manually insert).
2. **Facts for Author Confirmation** (short bulleted list of any `[PLACEHOLDER]` items or unverified details).
3. **Policy Retrieval & Placement Notes** (official venue policy URL, retrieval date, required placement/checklist notes, or `UNVERIFIED` notice; plus source record paths used).

Before delivery, check that every described use names a supported action and its scope, verify every factual assertion against the supplied information, ensure uncertainty remains visible, and confirm the output is still a standalone draft. No reviewer agent, external model call, or publication action is required.

## Integration and sources

`ts-paper-plan` may hand off the paper context and available usage records. Return
a separate draft path or chat draft; never merge declaration prose into its
manuscript blueprint. Cite-specific work, if actually needed, remains with the
existing citation workflow; do not alter the bibliography automatically.

The task vocabulary is copied unchanged from
[GAIDeT Declaration](https://github.com/panbibliotekar/gaidet-declaration)
at `9fac8c0b184f512e439764e83b6c123e76c60919` (`_data/terms.yml`), with its
[MIT license](references/LICENSE-gaidet). The website generator and its preset
assurances are not installed. The local instructions implement the user's
draft-only workflow; they are not an official venue policy.
