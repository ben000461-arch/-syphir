from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
import re

app = FastAPI(title="Syphir Scanner", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://syphir-api.onrender.com"],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

# Build a pattern-only NLP engine (no spaCy model needed)
configuration = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
}

# Use a simple regex-only engine instead
from presidio_analyzer.nlp_engine import NlpArtifacts
from presidio_analyzer import EntityRecognizer

class PatternOnlyNlpEngine:
    """Stub NLP engine — no model, no memory cost."""
    def process_text(self, text, language):
        return NlpArtifacts(
            entities=[], tokens=[], tokens_indices=[],
            detected_language=language, nlp_artifacts=None, lemmas=[]
        )
    def is_loaded(self): return True
    def get_supported_languages(self): return ["en"]
    def get_supported_entities(self): return []

analyzer = AnalyzerEngine(nlp_engine=PatternOnlyNlpEngine(), supported_languages=["en"])

# ── Custom recognizers ──────────────────────────────────────────────────────

# SSN
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="US_SSN",
    patterns=[Pattern("SSN", r"\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b", 0.85)]
))

# Credit cards
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="CREDIT_CARD",
    patterns=[
        Pattern("Visa/MC/Discover", r"\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|6(?:011|5\d{2})\d{12})\b", 0.9),
        Pattern("Amex", r"\b3[47]\d{13}\b", 0.9),
        Pattern("Generic 16-digit", r"\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b", 0.75),
    ]
))

# Email
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="EMAIL_ADDRESS",
    patterns=[Pattern("Email", r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", 0.9)]
))

# Phone
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="PHONE_NUMBER",
    patterns=[
        Pattern("US Phone", r"\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", 0.75),
        Pattern("Intl Phone", r"\b\+\d{1,3}[\s\-]?\d{1,4}[\s\-]?\d{1,4}[\s\-]?\d{1,9}\b", 0.6),
    ]
))

# API keys / secrets
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="API_KEY",
    patterns=[
        Pattern("OpenAI key", r"\bsk-[A-Za-z0-9]{20,}\b", 0.95),
        Pattern("Anthropic key", r"\bsk-ant-[A-Za-z0-9\-_]{20,}\b", 0.95),
        Pattern("Generic secret", r"\b(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token)\s*[:=]\s*['\"]?[A-Za-z0-9\-_]{16,}['\"]?\b", 0.8),
        Pattern("Bearer token", r"\bBearer\s+[A-Za-z0-9\-_.~+/]+=*\b", 0.8),
    ]
))

# Medical record number
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="MEDICAL_RECORD",
    patterns=[Pattern("MRN", r"\b(?:MRN|medical\s+record)[\s:#]*\d{4,10}\b", 0.85)]
))

# DOB
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="DATE_OF_BIRTH",
    patterns=[
        Pattern("DOB label", r"\b(?:dob|date\s+of\s+birth)\s*[:\/]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b", 0.9),
    ]
))

# EIN (Tax ID)
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="US_EIN",
    patterns=[Pattern("EIN", r"\b\d{2}-\d{7}\b", 0.8)]
))

# ── Request/Response models ─────────────────────────────────────────────────

class ScanRequest(BaseModel):
    text: str
    org_id: str | None = None

class Finding(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float
    text_snippet: str  # masked

class ScanResponse(BaseModel):
    has_pii: bool
    findings: list[Finding]
    risk_level: str  # low / medium / high / critical

# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "engine": "pattern-only", "spacy": False}

@app.post("/scan", response_model=ScanResponse)
def scan(req: ScanRequest):
    results = analyzer.analyze(text=req.text, language="en")
    
    findings = []
    for r in results:
        raw = req.text[r.start:r.end]
        # Mask: keep first 2 + last 2 chars
        if len(raw) > 6:
            masked = raw[:2] + "*" * (len(raw) - 4) + raw[-2:]
        else:
            masked = "****"
        findings.append(Finding(
            entity_type=r.entity_type,
            start=r.start,
            end=r.end,
            score=round(r.score, 3),
            text_snippet=masked,
        ))
    
    risk_level = "low"
    if findings:
        max_score = max(f.score for f in findings)
        critical_types = {"CREDIT_CARD", "US_SSN", "API_KEY"}
        if any(f.entity_type in critical_types for f in findings):
            risk_level = "critical"
        elif max_score >= 0.85:
            risk_level = "high"
        elif max_score >= 0.7:
            risk_level = "medium"
        else:
            risk_level = "low"
    
    return ScanResponse(
        has_pii=len(findings) > 0,
        findings=findings,
        risk_level=risk_level,
    )