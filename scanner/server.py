from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
import uvicorn

app = FastAPI(title="Syphir Scanner", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Presidio analyzer
provider = NlpEngineProvider(nlp_configuration={
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]
})
nlp_engine = provider.create_engine()
analyzer = AnalyzerEngine(nlp_engine=nlp_engine)

class ScanRequest(BaseModel):
    text: str
    org_id: str
    user_id: str
    ai_tool: str

class ScanResult(BaseModel):
    flagged: bool
    detections: list
    risk_level: str
    message: str

ENTITY_LABELS = {
    "PERSON": "Person name",
    "EMAIL_ADDRESS": "Email address",
    "PHONE_NUMBER": "Phone number",
    "US_SSN": "Social Security Number",
    "CREDIT_CARD": "Credit card number",
    "US_PASSPORT": "Passport number",
    "MEDICAL_LICENSE": "Medical license",
    "DATE_TIME": "Date/Time",
    "LOCATION": "Location",
    "NRP": "Nationality/Religion/Political group",
    "US_BANK_NUMBER": "Bank account number",
    "US_DRIVER_LICENSE": "Driver license",
    "IP_ADDRESS": "IP address",
    "URL": "URL",
    "IBAN_CODE": "IBAN code",
}

def get_risk_level(detections):
    high_risk = {"US_SSN", "CREDIT_CARD", "US_BANK_NUMBER", "MEDICAL_LICENSE", "US_PASSPORT"}
    medium_risk = {"PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_DRIVER_LICENSE"}

    if not detections:
        return "none"

    entity_types = {d["type"] for d in detections}

    if entity_types & high_risk:
        return "high"
    elif entity_types & medium_risk:
        return "medium"
    return "low"

@app.get("/health")
def health():
    return {"status": "ok", "service": "Syphir Scanner"}

@app.post("/scan", response_model=ScanResult)
def scan(request: ScanRequest):
    if not request.text or len(request.text.strip()) < 5:
        return ScanResult(
            flagged=False,
            detections=[],
            risk_level="none",
            message="Text too short to scan"
        )

    results = analyzer.analyze(
        text=request.text,
        language="en",
        entities=list(ENTITY_LABELS.keys())
    )

    detections = []
    seen = set()

    for result in results:
        if result.score >= 0.6:
            entity_type = result.entity_type
            if entity_type not in seen:
                seen.add(entity_type)
                detections.append({
                    "type": entity_type,
                    "label": ENTITY_LABELS.get(entity_type, entity_type),
                    "score": round(result.score, 2),
                    "start": result.start,
                    "end": result.end
                })

    flagged = len(detections) > 0
    risk_level = get_risk_level(detections)

    if flagged:
        labels = [d["label"] for d in detections]
        message = f"Sensitive data detected: {', '.join(labels)}"
    else:
        message = "No sensitive data detected"

    return ScanResult(
        flagged=flagged,
        detections=detections,
        risk_level=risk_level,
        message=message
    )

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=True)