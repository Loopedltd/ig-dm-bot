"""
AI Project Brain for Architecture — V1 (single-file starter)

Adds (minimal necessary changes):
- Loads .env via python-dotenv
- Uses /chat/completions for OpenAI calls (more compatible)
- Minimal Web UI at http://127.0.0.1:8000/
"""

from __future__ import annotations

import os
import json
import time
import sqlite3
from typing import Any, Dict, List, Optional, Literal

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# -----------------------------
# Load environment (.env)
# -----------------------------
load_dotenv()

# -----------------------------
# Config
# -----------------------------

DB_PATH = os.getenv("APP_DB_PATH", "./brain.db")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

SYSTEM_POLICY = """You are an architecture project intelligence assistant.
You must never generate a full design solution, drawings, or detailed architectural design.
You may:
- extract and structure requirements, constraints, risks, decisions, and priorities
- analyze site information and propose considerations/opportunities/risks
- critique and suggest beneficial adjustments to architect-provided designs (based on the project brain)
- draft briefs, rationales, narratives, and client-facing portfolios
You must:
- cite which project evidence (meeting/email/note/site input) supports claims, by referencing the record IDs when available
- avoid inventing facts not present in the project brain or supplied inputs
If information is missing, state what is missing and propose the minimal questions to resolve it.
Tone: clear, direct, professional.
"""

# -----------------------------
# Database
# -----------------------------

def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db() -> None:
    conn = db()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client_name TEXT,
        site_address TEXT,
        project_type TEXT,
        created_at INTEGER NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        record_type TEXT NOT NULL,
        source_label TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        statement TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'active',
        evidence_record_ids TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS design_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        label TEXT,
        design_notes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """)

    conn.commit()
    conn.close()

init_db()

# -----------------------------
# LLM Client (minimal fix: use /chat/completions)
# -----------------------------

class LLMError(Exception):
    pass

async def _openai_post(path: str, payload: dict) -> dict:
    if not OPENAI_API_KEY:
        raise LLMError("OPENAI_API_KEY is not set (check .env or export).")

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    url = f"{OPENAI_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=90) as client:
        try:
            r = await client.post(url, headers=headers, json=payload)
        except Exception as e:
            raise LLMError(f"Network error calling OpenAI: {e}")

    if r.status_code >= 400:
        try:
            err = r.json()
        except Exception:
            err = {"raw": r.text}
        raise LLMError(f"OpenAI error {r.status_code}: {json.dumps(err, indent=2)}")

    return r.json()

async def llm_text(prompt: str) -> str:
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_POLICY},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
    }
    data = await _openai_post("/chat/completions", payload)
    try:
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        raise LLMError(f"Unexpected response format: {e} — {data}")

async def llm_json(prompt: str, schema_hint: str) -> Dict[str, Any]:
    hard_prompt = (
        prompt
        + "\n\nReturn VALID JSON ONLY. No markdown, no backticks.\nSchema:\n"
        + schema_hint
    )

    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_POLICY},
            {"role": "user", "content": hard_prompt},
        ],
        "temperature": 0.2,
    }
    data = await _openai_post("/chat/completions", payload)

    try:
        raw = data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        raise LLMError(f"Unexpected response format: {e} — {data}")

    cleaned = raw.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(cleaned)
    except Exception as e:
        raise LLMError(f"Model did not return valid JSON. Error: {e}. Raw:\n{raw}")

# -----------------------------
# Models
# -----------------------------

RecordType = Literal["meeting", "email", "note", "site"]

class ProjectCreate(BaseModel):
    name: str
    client_name: Optional[str] = None
    site_address: Optional[str] = None
    project_type: Optional[str] = None

class ProjectOut(BaseModel):
    id: int
    name: str
    client_name: Optional[str]
    site_address: Optional[str]
    project_type: Optional[str]
    created_at: int

class IngestText(BaseModel):
    record_type: RecordType
    source_label: Optional[str] = None
    content: str = Field(min_length=1)

class IngestSite(BaseModel):
    site_address: Optional[str] = None
    notes: str = Field(default="")

class FactOut(BaseModel):
    id: int
    category: str
    statement: str
    importance: int
    status: str
    evidence_record_ids: List[int] = []
    created_at: int
    updated_at: int

class BrainOut(BaseModel):
    project: ProjectOut
    facts: Dict[str, List[FactOut]]

class GenerateBriefIn(BaseModel):
    include_categories: Optional[List[str]] = None

class DesignReviewIn(BaseModel):
    design_label: Optional[str] = None
    design_notes: str = Field(min_length=1)
    areas_summary: Optional[str] = None
    key_drawings_list: Optional[List[str]] = None
    questions_to_answer: Optional[List[str]] = None

class PortfolioIn(BaseModel):
    title: Optional[str] = None
    include_images_placeholders: bool = True
    audience: Literal["client", "planning", "award", "internal"] = "client"

# -----------------------------
# Core logic
# -----------------------------

FACT_CATEGORIES = [
    "goals",
    "requirements",
    "constraints",
    "budget_signals",
    "risks",
    "decisions",
    "open_questions",
    "stakeholders",
    "site_factors",
    "opportunities",
]

EXTRACTION_SCHEMA_HINT = """
{
  "facts": [
    {
      "category": "goals|requirements|constraints|budget_signals|risks|decisions|open_questions|stakeholders|site_factors|opportunities",
      "statement": "string (one clear atomic fact)",
      "importance": 1-5,
      "status": "active",
      "evidence_record_ids": [123, 124]
    }
  ]
}
"""

def get_project_or_404(project_id: int) -> sqlite3.Row:
    conn = db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return row

def insert_record(project_id: int, record_type: str, source_label: Optional[str], content: str) -> int:
    conn = db()
    cur = conn.cursor()
    now = int(time.time())
    cur.execute(
        "INSERT INTO records(project_id, record_type, source_label, content, created_at) VALUES (?,?,?,?,?)",
        (project_id, record_type, source_label, content, now),
    )
    rid = cur.lastrowid
    conn.commit()
    conn.close()
    return int(rid)

def upsert_fact(project_id: int, category: str, statement: str, importance: int, status: str, evidence_record_ids: List[int]) -> int:
    conn = db()
    cur = conn.cursor()
    now = int(time.time())

    cur.execute(
        "SELECT id, evidence_record_ids, importance FROM facts WHERE project_id=? AND category=? AND statement=? AND status='active'",
        (project_id, category, statement),
    )
    row = cur.fetchone()

    if row:
        try:
            existing_ids = json.loads(row["evidence_record_ids"] or "[]")
        except Exception:
            existing_ids = []
        merged = sorted(set(existing_ids + evidence_record_ids))
        new_importance = max(int(row["importance"]), int(importance))
        cur.execute(
            "UPDATE facts SET evidence_record_ids=?, importance=?, updated_at=? WHERE id=?",
            (json.dumps(merged), new_importance, now, row["id"]),
        )
        fid = row["id"]
    else:
        cur.execute(
            """INSERT INTO facts(project_id, category, statement, importance, status, evidence_record_ids, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (project_id, category, statement, int(importance), status, json.dumps(evidence_record_ids), now, now),
        )
        fid = cur.lastrowid

    conn.commit()
    conn.close()
    return int(fid)

def fetch_project_facts(project_id: int) -> Dict[str, List[sqlite3.Row]]:
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM facts WHERE project_id=? AND status='active' ORDER BY category, importance DESC, updated_at DESC",
        (project_id,),
    )
    rows = cur.fetchall()
    conn.close()
    grouped: Dict[str, List[sqlite3.Row]] = {c: [] for c in FACT_CATEGORIES}
    for r in rows:
        grouped.setdefault(r["category"], []).append(r)
    return grouped

def fetch_project_records(project_id: int, limit: int = 50) -> List[sqlite3.Row]:
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM records WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
        (project_id, limit),
    )
    rows = cur.fetchall()
    conn.close()
    return rows

def rows_to_project_out(row: sqlite3.Row) -> ProjectOut:
    return ProjectOut(
        id=row["id"],
        name=row["name"],
        client_name=row["client_name"],
        site_address=row["site_address"],
        project_type=row["project_type"],
        created_at=row["created_at"],
    )

def row_to_fact_out(r: sqlite3.Row) -> FactOut:
    try:
        eids = json.loads(r["evidence_record_ids"] or "[]")
    except Exception:
        eids = []
    return FactOut(
        id=r["id"],
        category=r["category"],
        statement=r["statement"],
        importance=int(r["importance"]),
        status=r["status"],
        evidence_record_ids=[int(x) for x in eids],
        created_at=int(r["created_at"]),
        updated_at=int(r["updated_at"]),
    )

# -----------------------------
# Prompts
# -----------------------------

def build_extraction_prompt(project: sqlite3.Row, record_id: int, record_type: str, source_label: Optional[str], content: str) -> str:
    return f"""
Project:
- name: {project["name"]}
- client_name: {project["client_name"] or ""}
- site_address: {project["site_address"] or ""}
- project_type: {project["project_type"] or ""}

New record to ingest:
- record_id: {record_id}
- record_type: {record_type}
- source_label: {source_label or ""}
- content:
\"\"\"{content}\"\"\"

Task:
Extract atomic, non-duplicative facts relevant to architectural project delivery and store them into the Project Brain.
Only extract facts supported by the content above. If unsure, do not include.
Assign each fact a category from the allowed list and importance 1..5.
Include evidence_record_ids as [record_id] for all extracted facts.

Allowed categories:
{", ".join(FACT_CATEGORIES)}

Return JSON only per schema.
""".strip()

def build_site_analysis_prompt(project: sqlite3.Row, record_id: int, site_address: str, notes: str, extra_text: str) -> str:
    return f"""
Project:
- name: {project["name"]}
- project_type: {project["project_type"] or ""}

Site analysis input (record_id={record_id}):
- site_address: {site_address}
- notes:
\"\"\"{notes}\"\"\"
- extra_text:
\"\"\"{extra_text}\"\"\"

Task:
Extract site intelligence as structured facts for the Project Brain.
Allowed categories: site_factors, opportunities, constraints, risks.
Rules:
- No invented measurements.
- Prefer architecture-relevant observations: access, adjacencies, noise, movement, typologies, experiential notes.
- Include evidence_record_ids: [record_id]
Return JSON only per schema.
""".strip()

def build_brief_prompt(project: sqlite3.Row, facts: Dict[str, List[sqlite3.Row]]) -> str:
    def fmt(cat: str) -> str:
        out = []
        for r in facts.get(cat, []):
            try:
                eids = json.loads(r["evidence_record_ids"] or "[]")
            except Exception:
                eids = []
            out.append(f"- ({r['importance']}/5) {r['statement']} [evidence: {eids}]")
        return "\n".join(out) if out else "- (none)"

    return f"""
Project:
- name: {project["name"]}
- client_name: {project["client_name"] or ""}
- site_address: {project["site_address"] or ""}
- project_type: {project["project_type"] or ""}

Project Brain (active facts):
CLIENT GOALS:
{fmt("goals")}

FUNCTIONAL REQUIREMENTS:
{fmt("requirements")}

CONSTRAINTS:
{fmt("constraints")}

BUDGET SIGNALS:
{fmt("budget_signals")}

SITE FACTORS:
{fmt("site_factors")}

OPPORTUNITIES:
{fmt("opportunities")}

RISKS:
{fmt("risks")}

DECISIONS TO DATE:
{fmt("decisions")}

OPEN QUESTIONS:
{fmt("open_questions")}

STAKEHOLDERS:
{fmt("stakeholders")}

Task:
Write a professional Architectural Brief.
- Do NOT invent facts.
- Cite evidence IDs inline like [evidence: 12, 19].
- Call out contradictions and missing info as "Clarifications Needed".
- End with a "Next 7 Days" action list.
""".strip()

def build_design_review_prompt(project: sqlite3.Row, facts: Dict[str, List[sqlite3.Row]], design: DesignReviewIn, design_version_id: int) -> str:
    def top(cat: str) -> str:
        lines = []
        for r in facts.get(cat, []):
            if int(r["importance"]) >= 3:
                try:
                    eids = json.loads(r["evidence_record_ids"] or "[]")
                except Exception:
                    eids = []
                lines.append(f"- {r['statement']} [evidence: {eids}]")
        return "\n".join(lines) if lines else "- (none)"

    return f"""
Project:
- name: {project["name"]}
- client_name: {project["client_name"] or ""}
- site_address: {project["site_address"] or ""}
- project_type: {project["project_type"] or ""}

Project Brain (high-signal facts):
GOALS:
{top("goals")}

REQUIREMENTS:
{top("requirements")}

CONSTRAINTS:
{top("constraints")}

BUDGET SIGNALS:
{top("budget_signals")}

SITE FACTORS + OPPORTUNITIES:
{top("site_factors")}
{top("opportunities")}

RISKS:
{top("risks")}

DECISIONS:
{top("decisions")}

DESIGN VERSION:
- design_version_id: {design_version_id}
- label: {design.design_label or ""}
- areas_summary:
{design.areas_summary or "(none)"}
- design_notes:
\"\"\"{design.design_notes}\"\"\"

Task:
Give specific beneficial adjustments WITHOUT generating a full design.
Output:
1) Alignment Check
2) Gaps & Conflicts
3) High-Impact Adjustments (ranked 1..5) with Why + Evidence + Trade-offs
4) Immediate Next Steps
""".strip()

def build_portfolio_prompt(project: sqlite3.Row, facts: Dict[str, List[sqlite3.Row]], portfolio: PortfolioIn) -> str:
    def compact(cat: str, max_items: int = 8) -> str:
        items = []
        for r in facts.get(cat, [])[:max_items]:
            try:
                eids = json.loads(r["evidence_record_ids"] or "[]")
            except Exception:
                eids = []
            items.append(f"- {r['statement']} [evidence: {eids}]")
        return "\n".join(items) if items else "- (none)"

    title = portfolio.title or f"{project['name']} — Client Portfolio"
    img_hint = """
Include image placeholders like:
[IMAGE: Site photo]
[IMAGE: Concept diagram]
[IMAGE: Ground floor plan]
[IMAGE: Section]
[IMAGE: Final render]
""" if portfolio.include_images_placeholders else "Do not include image placeholders."

    return f"""
Project:
- title: {title}
- client_name: {project["client_name"] or ""}
- site_address: {project["site_address"] or ""}
- project_type: {project["project_type"] or ""}

Project Brain (selected):
GOALS:
{compact("goals")}

REQUIREMENTS:
{compact("requirements")}

SITE FACTORS:
{compact("site_factors")}

OPPORTUNITIES:
{compact("opportunities")}

CONSTRAINTS:
{compact("constraints")}

KEY DECISIONS:
{compact("decisions")}

RISKS:
{compact("risks")}

Task:
Generate a client-facing portfolio in Markdown.
- Do NOT invent facts.
- Structure:
  1) Executive Summary
  2) Project Brief
  3) Site & Context
  4) Design Approach (high-level narrative only)
  5) Key Decisions & Rationale
  6) What We Delivered
  7) Next Steps / Handover Notes
- {img_hint}
""".strip()

# -----------------------------
# FastAPI
# -----------------------------

app = FastAPI(title="AI Project Brain (Architecture) — V1")

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/projects", response_model=ProjectOut)
def create_project(p: ProjectCreate):
    conn = db()
    cur = conn.cursor()
    now = int(time.time())
    cur.execute(
        "INSERT INTO projects(name, client_name, site_address, project_type, created_at) VALUES (?,?,?,?,?)",
        (p.name, p.client_name, p.site_address, p.project_type, now),
    )
    pid = cur.lastrowid
    conn.commit()
    cur.execute("SELECT * FROM projects WHERE id=?", (pid,))
    row = cur.fetchone()
    conn.close()
    return rows_to_project_out(row)

@app.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: int):
    row = get_project_or_404(project_id)
    return rows_to_project_out(row)

@app.get("/projects/{project_id}/brain", response_model=BrainOut)
def get_brain(project_id: int):
    project = get_project_or_404(project_id)
    facts = fetch_project_facts(project_id)
    out: Dict[str, List[FactOut]] = {}
    for cat, rows in facts.items():
        out[cat] = [row_to_fact_out(r) for r in rows]
    return BrainOut(project=rows_to_project_out(project), facts=out)

@app.post("/projects/{project_id}/ingest/text")
async def ingest_text(project_id: int, payload: IngestText):
    project = get_project_or_404(project_id)
    rid = insert_record(project_id, payload.record_type, payload.source_label, payload.content)

    prompt = build_extraction_prompt(project, rid, payload.record_type, payload.source_label, payload.content)
    try:
        extracted = await llm_json(prompt, EXTRACTION_SCHEMA_HINT)
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))

    facts = extracted.get("facts", [])
    created_fact_ids = []
    for f in facts:
        cat = f.get("category")
        if cat not in FACT_CATEGORIES:
            continue
        statement = (f.get("statement") or "").strip()
        if not statement:
            continue
        importance = int(f.get("importance") or 3)
        importance = max(1, min(5, importance))
        status = f.get("status") or "active"
        eids = f.get("evidence_record_ids") or [rid]
        eids = [int(x) for x in eids] if isinstance(eids, list) else [rid]
        created_fact_ids.append(upsert_fact(project_id, cat, statement, importance, status, eids))

    return {"record_id": rid, "facts_added_or_updated": len(created_fact_ids), "fact_ids": created_fact_ids}

@app.post("/projects/{project_id}/ingest/site")
async def ingest_site(project_id: int, payload: IngestSite):
    project = get_project_or_404(project_id)

    if payload.site_address:
        conn = db()
        cur = conn.cursor()
        cur.execute("UPDATE projects SET site_address=? WHERE id=?", (payload.site_address, project_id))
        conn.commit()
        conn.close()
        project = get_project_or_404(project_id)

    site_address = payload.site_address or (project["site_address"] or "")
    if not site_address and not payload.notes:
        raise HTTPException(status_code=400, detail="Provide at least site_address or notes")

    content = f"SITE ADDRESS: {site_address}\n\nSITE NOTES:\n{payload.notes}"
    rid = insert_record(project_id, "site", "Site intake", content)

    prompt = build_site_analysis_prompt(project, rid, site_address, payload.notes, extra_text="")
    try:
        extracted = await llm_json(prompt, EXTRACTION_SCHEMA_HINT)
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))

    created_fact_ids = []
    for f in extracted.get("facts", []):
        cat = f.get("category")
        if cat not in ["site_factors", "opportunities", "constraints", "risks"]:
            continue
        statement = (f.get("statement") or "").strip()
        if not statement:
            continue
        importance = int(f.get("importance") or 3)
        importance = max(1, min(5, importance))
        status = f.get("status") or "active"
        eids = f.get("evidence_record_ids") or [rid]
        eids = [int(x) for x in eids] if isinstance(eids, list) else [rid]
        created_fact_ids.append(upsert_fact(project_id, cat, statement, importance, status, eids))

    return {"record_id": rid, "site_address": site_address, "facts_added_or_updated": len(created_fact_ids), "fact_ids": created_fact_ids}

@app.post("/projects/{project_id}/ingest/file_as_text")
async def ingest_file_as_text(project_id: int, record_type: RecordType, file: UploadFile = File(...)):
    raw = await file.read()
    try:
        content = raw.decode("utf-8", errors="replace")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode file; upload UTF-8 text.")
    payload = IngestText(record_type=record_type, source_label=file.filename, content=content)
    return await ingest_text(project_id, payload)

@app.post("/projects/{project_id}/generate/brief")
async def generate_brief(project_id: int, payload: GenerateBriefIn = GenerateBriefIn()):
    project = get_project_or_404(project_id)
    facts = fetch_project_facts(project_id)

    if payload.include_categories:
        allowed = set(payload.include_categories)
        facts = {k: v for k, v in facts.items() if k in allowed}

    prompt = build_brief_prompt(project, facts)
    try:
        brief = await llm_text(prompt)
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"brief_markdown": brief}

@app.post("/projects/{project_id}/review/design")
async def review_design(project_id: int, payload: DesignReviewIn):
    project = get_project_or_404(project_id)
    facts = fetch_project_facts(project_id)

    conn = db()
    cur = conn.cursor()
    now = int(time.time())
    cur.execute(
        "INSERT INTO design_versions(project_id, label, design_notes, created_at) VALUES (?,?,?,?)",
        (project_id, payload.design_label, payload.design_notes, now),
    )
    design_version_id = int(cur.lastrowid)
    conn.commit()
    conn.close()

    prompt = build_design_review_prompt(project, facts, payload, design_version_id)
    try:
        feedback = await llm_text(prompt)
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"design_version_id": design_version_id, "review_markdown": feedback}

@app.post("/projects/{project_id}/generate/portfolio")
async def generate_portfolio(project_id: int, payload: PortfolioIn):
    project = get_project_or_404(project_id)
    facts = fetch_project_facts(project_id)
    prompt = build_portfolio_prompt(project, facts, payload)
    try:
        md = await llm_text(prompt)
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"portfolio_markdown": md}

@app.get("/projects/{project_id}/records")
def list_records(project_id: int, limit: int = 50):
    get_project_or_404(project_id)
    rows = fetch_project_records(project_id, limit=limit)
    return [{
        "id": r["id"],
        "record_type": r["record_type"],
        "source_label": r["source_label"],
        "created_at": r["created_at"],
        "content_preview": (r["content"][:300] + ("..." if len(r["content"]) > 300 else "")),
    } for r in rows]

# -----------------------------
# Minimal Web UI (added; does not change API)
# -----------------------------

def _page(title: str, body: str) -> str:
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; background: #0b0c10; color: #e8e8e8; }}
    .wrap {{ max-width: 980px; margin: 0 auto; padding: 28px 18px 60px; }}
    .top {{ display:flex; justify-content:space-between; align-items:center; gap: 12px; margin-bottom: 18px; }}
    h1 {{ font-size: 22px; margin: 0; }}
    h2 {{ font-size: 16px; margin: 18px 0 8px; }}
    .card {{ background: #12141a; border: 1px solid #222635; border-radius: 14px; padding: 14px; margin: 12px 0; }}
    .row {{ display:flex; gap: 12px; flex-wrap:wrap; }}
    .col {{ flex: 1; min-width: 260px; }}
    input, textarea, select {{ width:100%; box-sizing:border-box; border-radius: 10px; border: 1px solid #2a2f44; background:#0e1016; color:#e8e8e8; padding: 10px; }}
    textarea {{ min-height: 120px; }}
    button {{ border: 0; border-radius: 10px; padding: 10px 12px; background: #4b7bec; color: white; cursor:pointer; }}
    button.secondary {{ background: #2b2f42; }}
    a {{ color: #8ab4ff; text-decoration: none; }}
    .muted {{ color:#a6adbb; font-size: 13px; }}
    .pill {{ display:inline-block; padding: 4px 10px; border-radius: 999px; background:#20263a; border:1px solid #2a2f44; font-size: 12px; }}
    pre {{ white-space: pre-wrap; background: #0e1016; border: 1px solid #2a2f44; border-radius: 12px; padding: 12px; overflow:auto; }}
    .facts li {{ margin: 6px 0; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>{title}</h1>
      <div><a href="/">Projects</a> <span class="muted">|</span> <a href="/ui/new">New Project</a></div>
    </div>
    {body}
  </div>
</body>
</html>"""

def _fetch_projects() -> List[dict]:
    conn = db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM projects ORDER BY created_at DESC")
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/", response_class=HTMLResponse)
def ui_home():
    projects = _fetch_projects()
    items = ""
    for p in projects:
        items += f"""
        <div class="card">
          <div class="row">
            <div class="col">
              <div><span class="pill">#{p['id']}</span> <strong>{p['name']}</strong></div>
              <div class="muted">Client: {p.get('client_name') or "-"} • Type: {p.get('project_type') or "-"} • Site: {p.get('site_address') or "-"}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <a href="/ui/project/{p['id']}"><button>Open</button></a>
            </div>
          </div>
        </div>
        """
    if not items:
        items = """<div class="card"><div class="muted">No projects yet. Create one.</div></div>"""
    return _page("Project Brain", f"<div class='card'><div class='muted'>Minimal UI.</div></div>{items}")

@app.get("/ui/new", response_class=HTMLResponse)
def ui_new_project():
    body = """
    <div class="card">
      <form method="post" action="/ui/new">
        <div class="row">
          <div class="col"><label>Name</label><input name="name" required /></div>
          <div class="col"><label>Client</label><input name="client_name" /></div>
        </div>
        <div class="row">
          <div class="col"><label>Site address</label><input name="site_address" /></div>
          <div class="col"><label>Project type</label><input name="project_type" /></div>
        </div>
        <div style="margin-top:12px;"><button type="submit">Create Project</button></div>
      </form>
    </div>
    """
    return _page("New Project", body)

@app.post("/ui/new")
def ui_new_project_post(name: str = "", client_name: str = "", site_address: str = "", project_type: str = ""):
    conn = db()
    cur = conn.cursor()
    now = int(time.time())
    cur.execute(
        "INSERT INTO projects(name, client_name, site_address, project_type, created_at) VALUES (?,?,?,?,?)",
        (name, client_name or None, site_address or None, project_type or None, now),
    )
    pid = int(cur.lastrowid)
    conn.commit()
    conn.close()
    return RedirectResponse(url=f"/ui/project/{pid}", status_code=303)

@app.get("/ui/project/{project_id}", response_class=HTMLResponse)
def ui_project(project_id: int):
    project = get_project_or_404(project_id)
    facts = fetch_project_facts(project_id)

    def fact_list(cat: str) -> str:
        rows = facts.get(cat, [])
        if not rows:
            return "<div class='muted'>None</div>"
        lis = ""
        for r in rows[:10]:
            try:
                eids = json.loads(r["evidence_record_ids"] or "[]")
            except Exception:
                eids = []
            lis += f"<li><span class='pill'>{r['importance']}/5</span> {r['statement']} <span class='muted'>evidence: {eids}</span></li>"
        return f"<ul class='facts'>{lis}</ul>"

    body = f"""
    <div class="card">
      <div><span class="pill">Project #{project_id}</span> <strong>{project['name']}</strong></div>
      <div class="muted">Client: {project['client_name'] or "-"} • Type: {project['project_type'] or "-"} • Site: {project['site_address'] or "-"}</div>
    </div>

    <div class="row">
      <div class="col card">
        <h2>Ingest meeting/email/note</h2>
        <form method="post" action="/ui/project/{project_id}/ingest_text">
          <label>Type</label>
          <select name="record_type">
            <option value="meeting">meeting</option>
            <option value="email">email</option>
            <option value="note">note</option>
          </select>
          <div style="height:8px"></div>
          <label>Source label</label>
          <input name="source_label" />
          <div style="height:8px"></div>
          <label>Content</label>
          <textarea name="content" required></textarea>
          <div style="margin-top:12px;"><button type="submit">Ingest</button></div>
        </form>
      </div>

      <div class="col card">
        <h2>Site analysis</h2>
        <form method="post" action="/ui/project/{project_id}/ingest_site">
          <label>Site address</label>
          <input name="site_address" value="{project['site_address'] or ''}" />
          <div style="height:8px"></div>
          <label>Site notes</label>
          <textarea name="notes" required></textarea>
          <div style="margin-top:12px;"><button type="submit">Analyze Site</button></div>
        </form>
      </div>
    </div>

    <div class="row">
      <div class="col card">
        <h2>Generate</h2>
        <form method="post" action="/ui/project/{project_id}/generate_brief">
          <button type="submit">Generate Brief</button>
          <button class="secondary" formaction="/ui/project/{project_id}/generate_portfolio" type="submit">Generate Portfolio</button>
        </form>
      </div>

      <div class="col card">
        <h2>Design review</h2>
        <form method="post" action="/ui/project/{project_id}/review_design">
          <label>Design label</label>
          <input name="design_label" />
          <div style="height:8px"></div>
          <label>Design notes</label>
          <textarea name="design_notes" required></textarea>
          <div style="height:8px"></div>
          <label>Areas summary (optional)</label>
          <textarea name="areas_summary"></textarea>
          <div style="margin-top:12px;"><button type="submit">Get Review</button></div>
        </form>
      </div>
    </div>

    <div class="card">
      <h2>Project Brain (top)</h2>
      <div class="row">
        <div class="col"><h2>Goals</h2>{fact_list("goals")}<h2>Requirements</h2>{fact_list("requirements")}</div>
        <div class="col"><h2>Constraints</h2>{fact_list("constraints")}<h2>Site</h2>{fact_list("site_factors")}</div>
        <div class="col"><h2>Opportunities</h2>{fact_list("opportunities")}<h2>Risks</h2>{fact_list("risks")}</div>
      </div>
    </div>
    """
    return _page(project["name"], body)

@app.post("/ui/project/{project_id}/ingest_text")
async def ui_ingest_text(project_id: int, record_type: str = "meeting", source_label: str = "", content: str = ""):
    await ingest_text(project_id, IngestText(record_type=record_type, source_label=source_label or None, content=content))
    return RedirectResponse(url=f"/ui/project/{project_id}", status_code=303)

@app.post("/ui/project/{project_id}/ingest_site")
async def ui_ingest_site(project_id: int, site_address: str = "", notes: str = ""):
    await ingest_site(project_id, IngestSite(site_address=site_address or None, notes=notes))
    return RedirectResponse(url=f"/ui/project/{project_id}", status_code=303)

@app.post("/ui/project/{project_id}/generate_brief", response_class=HTMLResponse)
async def ui_generate_brief(project_id: int):
    res = await generate_brief(project_id, GenerateBriefIn())
    md = res["brief_markdown"]
    return _page("Generated Brief", f"<div class='card'><pre>{md}</pre><a href='/ui/project/{project_id}'><button class='secondary'>Back</button></a></div>")

@app.post("/ui/project/{project_id}/generate_portfolio", response_class=HTMLResponse)
async def ui_generate_portfolio(project_id: int):
    res = await generate_portfolio(project_id, PortfolioIn(audience="client"))
    md = res["portfolio_markdown"]
    return _page("Generated Portfolio", f"<div class='card'><pre>{md}</pre><a href='/ui/project/{project_id}'><button class='secondary'>Back</button></a></div>")

@app.post("/ui/project/{project_id}/review_design", response_class=HTMLResponse)
async def ui_review_design(project_id: int, design_label: str = "", design_notes: str = "", areas_summary: str = ""):
    res = await review_design(project_id, DesignReviewIn(design_label=design_label or None, design_notes=design_notes, areas_summary=areas_summary or None))
    md = res["review_markdown"]
    return _page("Design Review", f"<div class='card'><pre>{md}</pre><a href='/ui/project/{project_id}'><button class='secondary'>Back</button></a></div>")
