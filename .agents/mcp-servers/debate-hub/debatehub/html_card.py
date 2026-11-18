"""Local single-file HTML human adjudication card generator.

Follows the project's human-annotation-page conventions:
  * Local file only, zero external JS/CSS/font dependencies.
  * Frozen <sessionId>.design.json written beside <sessionId>.html.
  * Randomized presentation order (from the session's fixed briefSeed).
  * AI judge tendency / Elo ranking folded behind a toggle (blind pass first).
  * Explicit verified vs. unverified evidence-anchor badges.
  * localStorage autosave (with blocked-storage banner) + JSON download that
    imports directly into debate_human_submit(answersFile=...).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .evidence import check_artifact_staleness
from .store import utc_now


def _wsl_windows_path(path: Path) -> Optional[str]:
    if shutil.which("wslpath") is None:
        return None
    try:
        res = subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def _answer_options(preset: str, brief: Dict[str, Any]) -> List[Dict[str, str]]:
    if preset == "topic_tournament":
        opts = [
            {"code": str(i), "verdict": f"APPROVED_TOPIC:{c['candidateId']}",
             "selectedCandidateId": c["candidateId"],
             "label": f"批准 {c['displayLabel']}：{c['title']}"}
            for i, c in enumerate(brief.get("candidatesBlindOrder") or [], 1)
        ]
        opts.append({"code": "V", "verdict": "VALIDATE_FIRST", "selectedCandidateId": "",
                     "label": "先做最小验证 (VALIDATE_FIRST)"})
        opts.append({"code": "R", "verdict": "REJECT_ALL", "selectedCandidateId": "",
                     "label": "全部拒绝 / 重新选题"})
        opts.append({"code": "?", "verdict": "UNSURE", "selectedCandidateId": "",
                     "label": "暂不确定 (?)"})
        return opts
    if preset == "challenge_adjudication":
        return [
            {"code": "1", "verdict": "RESOLVED", "label": "已解决 (RESOLVED)"},
            {"code": "2", "verdict": "UNRESOLVED", "label": "未解决 — 保持阻塞 (UNRESOLVED)"},
            {"code": "3", "verdict": "ADMISSIBLE_LIMITATION", "label": "可接受局限 (ADMISSIBLE_LIMITATION)"},
            {"code": "?", "verdict": "NEED_MORE_EVIDENCE", "label": "需补实验 / 证据 (?)"},
        ]
    return [
        {"code": "1", "verdict": "SUPPORT", "label": "支持 / 通过 (SUPPORT)"},
        {"code": "2", "verdict": "OPPOSE", "label": "反对 / 驳回 (OPPOSE)"},
        {"code": "3", "verdict": "BLOCKED", "label": "阻塞 — 缺关键证据 (BLOCKED)"},
        {"code": "?", "verdict": "UNSURE", "label": "暂不确定 (?)"},
    ]


def generate_adjudication_card(session: Dict[str, Any], cards_dir: Path,
                               output_path: Optional[Path] = None) -> Dict[str, Any]:
    cards_dir.mkdir(parents=True, exist_ok=True)
    sid = session["sessionId"]
    brief = session.get("decisionBrief")
    if not brief:
        raise ValueError("session has no decisionBrief yet; run or post entries first")

    html_path = (output_path.resolve() if output_path else (cards_dir / f"{sid}.html").resolve())
    html_path.parent.mkdir(parents=True, exist_ok=True)
    design_path = html_path.with_suffix(".design.json")

    options = _answer_options(session["preset"], brief)
    staleness = check_artifact_staleness(session.get("artifacts") or [])
    design = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "sessionId": sid,
        "preset": session["preset"],
        "title": session.get("title"),
        "question": session.get("question"),
        "seed": brief.get("seed"),
        "artifactHashes": {a["displayPath"]: a["sha256"] for a in session.get("artifacts") or []},
        "staleAtGeneration": staleness["stale"],
        "options": options,
        "blindPolicy": "AI judge recommendation and Elo ranking are collapsed by default; record initial judgment before revealing.",
    }
    design_path.write_text(json.dumps(design, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    payload = {
        "sessionId": sid,
        "preset": session["preset"],
        "title": session.get("title") or sid,
        "question": session.get("question") or "",
        "challenge": session.get("challenge"),
        "artifacts": session.get("artifacts") or [],
        "staleness": staleness,
        "escalationReasons": (session.get("aiOutcome") or {}).get("escalationReasons") or [],
        "brief": brief,
        "options": options,
        "generatedAt": design["generatedAt"],
    }
    safe_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    html = _HTML_TEMPLATE.replace("__PAYLOAD_JSON__", safe_json).replace("__SESSION_ID__", sid)
    html_path.write_text(html, encoding="utf-8")

    win_path = _wsl_windows_path(html_path)
    return {
        "htmlPath": str(html_path),
        "designPath": str(design_path),
        "windowsPath": win_path,
        "generatedAt": design["generatedAt"],
        "staleAtGeneration": staleness["stale"],
    }


_HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人工裁决卡片 — __SESSION_ID__</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --ink: #182026; --muted: #5c6b77;
  --line: #d8e1e8; --accent: #1d4ed8; --ok: #15803d; --ok-bg: #ecfdf5;
  --warn: #b45309; --warn-bg: #fffbeb; --bad: #b91c1c; --bad-bg: #fef2f2;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid var(--line); }
.wrap { max-width: 980px; margin: 0 auto; padding: 14px 20px; }
header h1 { margin: 0 0 4px; font-size: 18px; }
.meta { font-family: var(--mono); font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 12px; }
.banner { padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 14px; border: 1px solid; }
.banner.warn { background: var(--warn-bg); border-color: #f59e0b; color: var(--warn); }
.banner.bad { background: var(--bad-bg); border-color: #ef4444; color: var(--bad); }
.banner[hidden] { display: none; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 14px 0; }
.card h2 { margin: 0 0 8px; font-size: 16px; }
.card h3 { margin: 10px 0 6px; font-size: 14px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-family: var(--mono); font-weight: 600; }
.badge.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid #86efac; }
.badge.bad { background: var(--bad-bg); color: var(--bad); border: 1px solid #fca5a5; }
.badge.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #fcd34d; }
.badge.neutral { background: #eef2f6; color: var(--muted); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.pos { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: #fbfcfd; }
.pos.downgraded { border-color: #f59e0b; background: #fffdf5; }
.quote { margin: 6px 0; padding: 8px 10px; border-left: 3px solid var(--line); background: #fff; font-size: 13px; }
.quote.ok { border-left-color: var(--ok); }
.quote.bad { border-left-color: var(--bad); }
.quote .qpath { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.quote pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12.5px; }
.opts { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
button.opt { cursor: pointer; border: 1px solid var(--line); background: #fff; padding: 8px 12px; border-radius: 8px; font-size: 14px; text-align: left; }
button.opt:hover { border-color: var(--accent); }
button.opt[aria-pressed="true"] { background: #eff6ff; border-color: var(--accent); color: var(--accent); font-weight: 600; }
button.primary { cursor: pointer; background: var(--accent); color: #fff; border: 0; padding: 9px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; }
button.primary:disabled { opacity: 0.45; cursor: not-allowed; }
button.ghost { cursor: pointer; background: #fff; color: var(--ink); border: 1px solid var(--line); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
textarea { width: 100%; min-height: 92px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
details.ai { border: 1px dashed #94a3b8; border-radius: 8px; padding: 10px 14px; background: #f8fafc; }
details.ai summary { cursor: pointer; font-weight: 600; color: var(--muted); }
ul { margin: 6px 0; padding-left: 20px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; }
th { background: #f1f5f9; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
.status-text { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1 id="h-title">人工裁决卡片</h1>
    <div class="meta" id="h-meta"></div>
  </div>
</header>

<main class="wrap">
  <div id="storage-warn" class="banner warn" hidden>当前浏览器阻止了本地存储（localStorage），关闭标签页前请务必点击“下载裁决 JSON”。</div>
  <div id="stale-warn" class="banner bad" hidden>警告：原始材料文件在生成此卡片时已发生变化（哈希不一致）。请先确认是否需要重跑辩论。</div>

  <section class="card" id="sec-overview"></section>
  <section class="card" id="sec-sides"></section>

  <section class="card">
    <h2>AI 裁判参考（默认折叠，防止锚定偏差）</h2>
    <p class="status-text">建议先在下方形成自己的初步判断，再决定是否展开查看 AI 裁判意见与模型家族独立性报告。</p>
    <details class="ai" id="ai-details">
      <summary>点击展开 AI 裁判参考与独立性报告</summary>
      <div id="ai-body" style="margin-top:10px;"></div>
    </details>
  </section>

  <section class="card">
    <h2>你的最终裁决</h2>
    <p class="status-text">快捷键：按选项前的数字 / 字母键快速选择（焦点不在文本框时生效）。人工裁决会单独落盘，不与 AI 审稿人结论混用。</p>
    <div class="opts" id="opt-list"></div>
    <label for="rationale"><b>裁决理由（必填，用于审计与可追溯）：</b></label>
    <textarea id="rationale" placeholder="写明依据了哪条核验过的原文证据、为什么采纳或推翻某一立场、以及是否需要补充检查……"></textarea>
    <div class="actions">
      <button class="primary" id="btn-download" disabled>下载裁决 JSON</button>
      <button class="ghost" id="btn-clear">清空本地草稿</button>
      <span class="status-text" id="save-status">尚未作答</span>
    </div>
  </section>
</main>

<script>
const DATA = __PAYLOAD_JSON__;
const STORAGE_KEY = "debate-hub-card-" + DATA.sessionId;
let storageOk = true;
const state = {
  verdict: "",
  selectedCandidateId: "",
  rationale: "",
  blindPassFirst: null,
  aiRevealedBeforeSubmit: false,
  updatedAt: null
};

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined) node.append(k);
  return node;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (e) {
    storageOk = false;
    document.getElementById("storage-warn").hidden = false;
  }
}

function persist() {
  state.updatedAt = new Date().toISOString();
  if (storageOk) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; document.getElementById("storage-warn").hidden = false; }
  }
  refreshControls();
}

function renderQuotes(quotes) {
  if (!quotes || !quotes.length) {
    return el("div", {class: "quote bad"}, el("span", {class: "badge bad"}, "未提供原文引文 — 已降级"));
  }
  const wrap = el("div");
  for (const q of quotes) {
    const ok = !!q.verified;
    const cls = ok ? "quote ok" : "quote bad";
    const badge = ok
      ? el("span", {class: "badge ok"}, "✓ 原文已核验 (" + q.matchKind + (q.matchedLine ? " L" + q.matchedLine : "") + ")")
      : el("span", {class: "badge bad"}, "⚠ 未核验 (" + (q.matchKind || "missing") + ")");
    wrap.append(el("div", {class: cls},
      el("div", {class: "qpath"}, badge, " ", q.path || "(未注明文件)"),
      el("pre", null, q.quote || "")
    ));
  }
  return wrap;
}

function renderHeaderAndOverview() {
  document.getElementById("h-title").textContent = DATA.title + " — 人工裁决卡片";
  const meta = document.getElementById("h-meta");
  meta.append(
    el("span", null, "sessionId: " + DATA.sessionId),
    el("span", null, "preset: " + DATA.preset),
    el("span", null, "order seed: " + DATA.brief.seed),
    el("span", null, "generated: " + DATA.generatedAt)
  );
  if (DATA.staleness && DATA.staleness.stale) {
    document.getElementById("stale-warn").hidden = false;
  }

  const ov = document.getElementById("sec-overview");
  ov.append(el("h2", null, "争议问题与核心分歧"));
  ov.append(el("p", null, el("b", null, "问题："), DATA.question));
  if (DATA.challenge) {
    ov.append(el("p", null,
      el("span", {class: "badge warn"}, DATA.challenge.challengeId + " / " + DATA.challenge.claimId + " (" + DATA.challenge.severity + ")"),
      " ", DATA.challenge.claimText || ""
    ));
    ov.append(el("p", null, el("b", null, "质疑内容："), DATA.challenge.challengeDescription || ""));
  }
  if (DATA.brief.coreCrux) {
    ov.append(el("p", null, el("b", null, "核心分歧点 (Crux)："), DATA.brief.coreCrux));
  }
  if (DATA.brief.decisiveEvidence) {
    ov.append(el("p", null, el("b", null, "可定案证据："), DATA.brief.decisiveEvidence));
  }
  if (DATA.escalationReasons && DATA.escalationReasons.length) {
    const ul = el("ul");
    for (const r of DATA.escalationReasons) ul.append(el("li", null, r));
    ov.append(el("h3", null, "升级给人工的原因"), ul);
  }
  if (DATA.artifacts && DATA.artifacts.length) {
    const ul = el("ul");
    for (const a of DATA.artifacts) {
      ul.append(el("li", {style: "font-family:var(--mono);font-size:12.5px"},
        a.displayPath + " (sha256: " + (a.sha256 || "").slice(0, 12) + ", " + a.bytes + " B)"));
    }
    ov.append(el("h3", null, "原始证据文件（已锁定哈希）"), ul);
  }
}

function renderSides() {
  const sec = document.getElementById("sec-sides");
  if (DATA.preset === "topic_tournament") {
    sec.append(el("h2", null, "候选方向对比（盲排顺序，已随机化）"));
    const grid = el("div", {class: "grid"});
    for (const c of DATA.brief.candidatesBlindOrder || []) {
      const box = el("div", {class: "pos"});
      box.append(el("h3", null, c.displayLabel + "：" + c.title + " ", el("span", {class: "badge neutral"}, c.candidateId)));
      if (c.summary) box.append(el("p", null, c.summary));
      if (c.strongestPros && c.strongestPros.length) {
        const ul = el("ul");
        for (const p of c.strongestPros) ul.append(el("li", null, p));
        box.append(el("b", null, "最强支持论点："), ul);
      }
      if (c.strongestCons && c.strongestCons.length) {
        const ul = el("ul");
        for (const p of c.strongestCons) ul.append(el("li", null, p));
        box.append(el("b", null, "主要风险 / 弱点："), ul);
      }
      if (c.decisiveChecks && c.decisiveChecks.length) {
        box.append(el("p", null, el("b", null, "决定性最小验证："), c.decisiveChecks.join("；")));
      }
      box.append(el("b", null, "锚定引文："), renderQuotes(c.quotes));
      grid.append(box);
    }
    sec.append(grid);
    if (DATA.brief.matches && DATA.brief.matches.length) {
      const tbl = el("table");
      tbl.append(el("tr", null, el("th", null, "场次"), el("th", null, "对阵"), el("th", null, "位置一致性"), el("th", null, "核心分歧")));
      for (const m of DATA.brief.matches) {
        const cons = m.positionConsistent === true ? "一致" : (m.positionConsistent === false ? "⚠ 位置翻转" : "单向");
        tbl.append(el("tr", null, el("td", null, m.matchId), el("td", null, m.candidateA + " vs " + m.candidateB),
          el("td", null, cons), el("td", null, m.crux || "")));
      }
      sec.append(el("h3", null, "两两对阵摘要"), tbl);
    }
    return;
  }

  sec.append(el("h2", null, "各方立场与锚定证据（盲排顺序，已随机化）"));
  const grid = el("div", {class: "grid"});
  for (const s of DATA.brief.positionsBlindOrder || []) {
    const box = el("div", {class: s.downgradedUnanchored ? "pos downgraded" : "pos"});
    const hdr = el("h3", null, s.displayLabel + " ", el("span", {class: "badge neutral"}, s.verdict || ""));
    if (s.downgradedUnanchored) hdr.append(" ", el("span", {class: "badge warn"}, "未锚定 — 已降级"));
    box.append(hdr);
    if (s.summary) box.append(el("p", null, s.summary));
    if (s.arguments && s.arguments.length) {
      const ul = el("ul");
      for (const a of s.arguments) ul.append(el("li", null, a));
      box.append(ul);
    }
    box.append(renderQuotes(s.quotes));
    grid.append(box);
  }
  sec.append(grid);
}

function renderAiReference() {
  const ai = DATA.brief.aiRecommendation || {};
  const body = document.getElementById("ai-body");
  if (DATA.preset === "topic_tournament") {
    const tbl = el("table");
    tbl.append(el("tr", null, el("th", null, "候选"), el("th", null, "Elo"), el("th", null, "胜/负/平/位置翻转")));
    for (const r of ai.rankedCandidates || []) {
      tbl.append(el("tr", null,
        el("td", null, r.candidateId + " — " + r.title),
        el("td", null, String(r.elo)),
        el("td", null, r.wins + "/" + r.losses + "/" + r.draws + "/" + r.inconsistent)
      ));
    }
    body.append(tbl);
  } else {
    body.append(el("p", null, el("b", null, "AI 综合结论："), (ai.verdict || "N/A") +
      (ai.confidence !== null && ai.confidence !== undefined ? " (置信度 " + ai.confidence + ")" : "")));
    for (const j of ai.judges || []) {
      body.append(el("p", null, el("span", {class: "badge neutral"}, j.agentId + " / " + j.family),
        " → ", el("b", null, j.verdict), "：", j.summary || ""));
    }
  }
  const indep = ai.independence || {};
  body.append(el("p", {class: "meta"},
    "辩手家族: " + (indep.debaterFamilies || []).join(", ") +
    " | 裁判家族: " + (indep.judgeFamilies || []).join(", ") +
    " | 跨家族裁判: " + String(indep.crossFamilyJudge)));
  for (const w of indep.warnings || []) {
    body.append(el("div", {class: "banner warn"}, w));
  }

  document.getElementById("ai-details").addEventListener("toggle", (ev) => {
    if (ev.target.open) {
      if (state.blindPassFirst === null) {
        state.blindPassFirst = Boolean(state.verdict);
      }
      state.aiRevealedBeforeSubmit = true;
      persist();
    }
  });
}

function renderOptions() {
  const list = document.getElementById("opt-list");
  for (const opt of DATA.options) {
    const btn = el("button", {class: "opt", type: "button", "data-verdict": opt.verdict, "data-code": opt.code},
      el("code", null, "[" + opt.code + "] "), opt.label);
    btn.addEventListener("click", () => {
      if (state.blindPassFirst === null) {
        state.blindPassFirst = !document.getElementById("ai-details").open;
      }
      state.verdict = opt.verdict;
      state.selectedCandidateId = opt.selectedCandidateId || "";
      persist();
    });
    list.append(btn);
  }
}

function refreshControls() {
  for (const btn of document.querySelectorAll("button.opt")) {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-verdict") === state.verdict ? "true" : "false");
  }
  const ta = document.getElementById("rationale");
  if (ta.value !== state.rationale) ta.value = state.rationale;
  const ready = Boolean(state.verdict && state.rationale.trim());
  document.getElementById("btn-download").disabled = !ready;
  document.getElementById("save-status").textContent = ready
    ? "已保存本地草稿，可下载裁决 JSON 并回传给 debate_human_submit。"
    : "请选择一项裁决并填写裁决理由。";
}

function initInteractions() {
  document.getElementById("rationale").addEventListener("input", (ev) => {
    state.rationale = ev.target.value;
    persist();
  });
  document.getElementById("btn-clear").addEventListener("click", () => {
    state.verdict = ""; state.selectedCandidateId = ""; state.rationale = "";
    state.blindPassFirst = null; state.aiRevealedBeforeSubmit = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    refreshControls();
  });
  document.getElementById("btn-download").addEventListener("click", () => {
    const out = {
      schemaVersion: 1,
      sessionId: DATA.sessionId,
      preset: DATA.preset,
      decidedAt: new Date().toISOString(),
      artifactHashesAtCardGen: Object.fromEntries((DATA.artifacts || []).map(a => [a.displayPath, a.sha256])),
      answers: [{
        verdict: state.verdict,
        selectedCandidateId: state.selectedCandidateId || null,
        rationale: state.rationale.trim(),
        blindPassFirst: state.blindPassFirst !== null ? state.blindPassFirst : !state.aiRevealedBeforeSubmit,
        aiRevealedBeforeSubmit: state.aiRevealedBeforeSubmit
      }]
    };
    const blob = new Blob([JSON.stringify(out, null, 2) + "\\n"], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = DATA.sessionId + "_human_decisions.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.addEventListener("keydown", (ev) => {
    if (document.activeElement && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) return;
    const key = ev.key.toUpperCase();
    const match = DATA.options.find(o => o.code.toUpperCase() === key);
    if (match) {
      const btn = document.querySelector('button.opt[data-verdict="' + CSS.escape(match.verdict) + '"]');
      if (btn) btn.click();
    }
  });
}

loadState();
renderHeaderAndOverview();
renderSides();
renderAiReference();
renderOptions();
initInteractions();
refreshControls();
</script>
</body>
</html>
"""
