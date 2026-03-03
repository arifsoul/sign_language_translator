from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from groq import Groq
from gtts import gTTS
from dotenv import load_dotenv
import io
import os
import base64
import uvicorn

import json
import configparser

CONFIG_FILE = "config.ini"

# Load environment variables
load_dotenv()

app = FastAPI()

# Load BISINDO Model Vocabulary for AI context
BISINDO_VOCAB = []
try:
    with open('bisindo_model.json', 'r') as f:
        model_data = json.load(f)
        BISINDO_VOCAB = sorted(list(model_data.keys()))
except Exception as e:
    print(f"⚠️ Error loading model vocab: {e}")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Groq client
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

@app.get("/metadata")
async def get_metadata():
    return {
        "vocab": BISINDO_VOCAB,
        "count": len(BISINDO_VOCAB),
        "status": "ready" if BISINDO_VOCAB else "no_model"
    }

@app.get("/bisindo_model.json")
async def serve_model():
    if not os.path.exists("bisindo_model.json"):
        raise HTTPException(status_code=404, detail="Model file not found")
    with open("bisindo_model.json", "r") as f:
        return json.load(f)

class GestureData(BaseModel):
    gesture_name: str
    landmarks: list = None

class ConfigData(BaseModel):
    match: float
    shake: float
    confidence: float

@app.get("/config")
async def get_config():
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    if 'thresholds' not in config:
        return {"match": 0.5, "shake": 0.5, "confidence": 0.5}
    return {
        "match": float(config['thresholds'].get('match', 0.5)),
        "shake": float(config['thresholds'].get('shake', 0.5)),
        "confidence": float(config['thresholds'].get('confidence', 0.5))
    }

@app.post("/config")
async def save_config(data: ConfigData):
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    if 'thresholds' not in config:
        config.add_section('thresholds')
    
    config.set('thresholds', 'match', str(data.match))
    config.set('thresholds', 'shake', str(data.shake))
    config.set('thresholds', 'confidence', str(data.confidence))
    
    with open(CONFIG_FILE, 'w') as f:
        config.write(f)
    
    return {"status": "success"}

@app.post("/translate")
async def translate_gesture(data: GestureData):
    try:
        # 1. Process with Groq for BISINDO contextual translation
        vocab_hint = ", ".join(BISINDO_VOCAB)
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": f"You are a professional BISINDO (Bahasa Isyarat Indonesia) interpreter. The user will provide a sequence of signs. Your task is to translate it into a natural, grammatically correct Indonesian sentence. \n\nCosakata yang tersedia dalam model deteksi kami adalah: [{vocab_hint}]. \nAsumsikan input adalah susunan huruf atau kata dari daftar tersebut. Berikan hasil akhir saja tanpa penjelasan."
                },
                {
                    "role": "user",
                    "content": f"Terjemahkan input BISINDO berikut: {data.gesture_name}"
                }
            ],
            max_tokens=60
        )
        
        translated_text = completion.choices[0].message.content.strip()

        # 2. Convert text to speech using gTTS
        tts = gTTS(text=translated_text, lang='id')
        audio_fp = io.BytesIO()
        tts.write_to_fp(audio_fp)
        audio_fp.seek(0)
        
        # 3. Encode audio to base64
        audio_base64 = base64.b64encode(audio_fp.read()).decode('utf-8')

        return {
            "original_gesture": data.gesture_name,
            "translated_text": translated_text,
            "audio_base64": audio_base64
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Note: Mount StaticFiles AFTER API routes so it doesn't shadow them
# Serving index.html on root '/' by setting html=True and mounting at '/'
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    print("\n🚀 Starting Sign Language Translator at http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)
