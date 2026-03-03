from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
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

# Load BISINDO Model Vocabulary and Prototypes for AI context
BISINDO_VOCAB = []
PROTOTYPES = {}
import math

try:
    with open('bisindo_model.json', 'r') as f:
        model_data = json.load(f)
        BISINDO_VOCAB = sorted(list(model_data.keys()))
        
        for key, samples in model_data.items():
            if not samples: continue
            # We no longer calculate an "average" prototype here because averaging 
            # rotated hands creates distorted centroids. We load all 20 variations.
            PROTOTYPES[key] = samples
            
except Exception as e:
    print(f"⚠️ Error loading model vocab/prototypes: {e}")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# (LLM Prediction disabled, previously Groq client initialized here)
client = None

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
    """Murni gTTS (Text to Speech) tanpa campur tangan LLM untuk terjemahan."""
    try:
        # Gunakan teks asli dari draf kata
        translated_text = data.gesture_name
        
        if not translated_text or translated_text == "-":
            return {"error": "Buffer kosong"}

        # 1. Convert text to speech using gTTS
        tts = gTTS(text=translated_text, lang='id')
        audio_fp = io.BytesIO()
        tts.write_to_fp(audio_fp)
        audio_fp.seek(0)
        
        # 2. Encode audio to base64
        audio_base64 = base64.b64encode(audio_fp.read()).decode('utf-8')

        return {
            "original_gesture": data.gesture_name,
            "translated_text": translated_text,
            "audio_base64": audio_base64
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/predict")
async def predict_sign(data: GestureData):
    """Menggunakan Groq AI untuk memprediksi huruf/angka berdasarkan landmarks."""
    if not data.landmarks:
        raise HTTPException(status_code=400, detail="Landmarks required")
    
    try:
        # 1. Normalize INPUT sama seperti frontend (Zero-centered & MaxDist scaled)
        l0 = data.landmarks[0]
        centered_input = []
        max_dist_input = 0.0
        for pt in data.landmarks:
            dx = pt["x"] - l0["x"]
            dy = pt["y"] - l0["y"]
            dz = pt["z"] - l0["z"]
            centered_input.append({"x": dx, "y": dy, "z": dz})
            dist = math.sqrt(dx*dx + dy*dy + dz*dz)
            if dist > max_dist_input: max_dist_input = dist
            
        if max_dist_input == 0: max_dist_input = 1.0
        
        rel_input = [{"x": p["x"]/max_dist_input, "y": p["y"]/max_dist_input, "z": p["z"]/max_dist_input} for p in centered_input]
        
        # 2. Compute Distances against PROTOTYPES
        best_match_key = "?"
        best_dist = float('inf')
        
        for key, variations in PROTOTYPES.items():
            if not isinstance(variations, list) or len(variations) == 0:
                continue
                
            # Cek format dictionary dan ekstrak list of landmarks yang sesuai
            samples = []
            if isinstance(variations[0], dict):
                if "landmarks" in variations[0]:
                    # Format baru (trainer.py / augmented.py): [{"handedness": "...", "landmarks": [...]}, ...]
                    samples = [v["landmarks"] for v in variations if "landmarks" in v]
                elif "x" in variations[0]:
                    # Format sangat lama: langsung list of 21 dict points
                    samples = [variations]
            elif isinstance(variations[0], list):
                # Format augmented lama: list of lists of dict points
                samples = variations
                
            for lms in samples:
                if not lms or len(lms) < 21: continue
                
                # Kita asumsikan lms sudah dinormalisasi oleh script augmentasi!
                # Tapi untuk double check dan konsistensi, kita hitung jarak langsung 
                # karena frontend juga sudah menormalisasinya dengan cara yang sama.
                
                dist = 0
                for i in range(21):
                    dist += math.sqrt(
                        (rel_input[i]["x"] - lms[i]["x"])**2 +
                        (rel_input[i]["y"] - lms[i]["y"])**2 +
                        (rel_input[i]["z"] - (lms[i].get("z", 0)))**2
                    )
                avg_dist = dist / 21.0
                
                if avg_dist < best_dist:
                    best_dist = avg_dist
                    best_match_key = key
                
        # 3. Evaluasi terhadap Threshold Konfigurasi
        # match_slider dari UI bernilai 0.0 - 1.0. Makin besar (e.g 1.0) artinya AI harus makin strict/yakin.
        config = configparser.ConfigParser()
        config.read(CONFIG_FILE)
        match_threshold = float(config['thresholds'].get('match', 0.5)) if 'thresholds' in config else 0.5
        
        # Range wajar avg_dist adalah 0.05 (sangat mirip) hingga ~0.4 (sangat beda).
        # Kita petakan ke dynamic_dist_threshold. Jika match_threshold=1.0 -> dist_thresh = 0.12 (Strict)
        # Jika match_threshold=0.0 -> dist_thresh = 0.40 (Loose)
        dynamic_dist_threshold = 0.40 - (match_threshold * 0.28)
        
        if best_dist > dynamic_dist_threshold:
            predicted_char = "?"
        else:
            predicted_char = best_match_key

        return {"prediction": predicted_char}

    except Exception as e:
        print(f"Prediction Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Note: Mount StaticFiles AFTER API routes so it doesn't shadow them
# Serving index.html on root '/' by setting html=True and mounting at '/'
app.mount("/", StaticFiles(directory=".", html=True), name="static")

import threading
import webbrowser
import time

def open_browser():
    # Wait a brief moment to ensure Uvicorn is up and running
    time.sleep(1.5)
    webbrowser.open("http://localhost:8000")

if __name__ == "__main__":
    print("\n🚀 Starting Sign Language Translator at http://localhost:8000\n")
    
    # Start the browser-opening thread before blocking the main thread with uvicorn
    threading.Thread(target=open_browser, daemon=True).start()
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
