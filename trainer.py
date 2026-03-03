import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import json
import numpy as np
import os
import requests

# Download model file if not exists (need the .task file)
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
MODEL_PATH = "hand_landmarker.task"

if not os.path.exists(MODEL_PATH):
    print("Downloading hand_landmarker.task model...")
    r = requests.get(MODEL_URL)
    with open(MODEL_PATH, "wb") as f:
        f.write(r.content)

# Initialize Hand Landmarker
base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
options = vision.HandLandmarkerOptions(base_options=base_options, num_hands=2)
detector = vision.HandLandmarker.create_from_options(options)

def load_image(file_path):
    """Load image from local disk."""
    if not os.path.exists(file_path):
        print(f"Error: File not found {file_path}")
        return None
    try:
        image = cv2.imread(file_path)
        if image is None:
            print(f"Error: Could not decode image {file_path}")
        return image
    except Exception as e:
        print(f"Error loading {file_path}: {e}")
        return None

def extract_landmarks(image):
    if image is None: return None
    try:
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
        detection_result = detector.detect(mp_image)
        
        if not detection_result.hand_world_landmarks:
            return None
        
        hands_data = []
        for idx, hand_landmarks in enumerate(detection_result.hand_world_landmarks):
            handedness = detection_result.handedness[idx][0].category_name.lower()
            
            # 1. Wrist-Centric & Scale Normalization (Metric Space)
            # hand_world_landmarks are already in meters. 
            # We center at wrist (landmark 0) and scale so max dist = 1.0
            raw_pts = np.array([[lm.x, lm.y, lm.z] for lm in hand_landmarks])
            wrist = raw_pts[0]
            
            # Center at wrist
            centered_pts = raw_pts - wrist
            
            # Calculate max distance for scaling (metric stability)
            max_dist = np.max(np.linalg.norm(centered_pts, axis=1))
            if max_dist == 0: max_dist = 1.0
            
            normalized_pts = centered_pts / max_dist
            
            # Format as simple list for JSON
            formatted_landmarks = []
            for pt in normalized_pts:
                formatted_landmarks.append({
                    'x': round(float(pt[0]), 6),
                    'y': round(float(pt[1]), 6),
                    'z': round(float(pt[2]), 6)
                })

            hands_data.append({
                'label': handedness,
                'landmarks': formatted_landmarks
            })
            
        return hands_data
    except Exception as e:
        print(f"Error: {e}")
        return None

def main():
    dataset_dir = 'bisindo_dataset'
    if not os.path.exists(dataset_dir):
        print(f"Error: {dataset_dir} not found")
        return

    model_data = {} # label -> list of samples
    total_images = 0
    success_count = 0

    print(f"🚀 Training ML Engine from directory structure: {dataset_dir}")

    # Walk through subfolders
    # Each folder name is the label
    for label in sorted(os.listdir(dataset_dir)):
        label_path = os.path.join(dataset_dir, label)
        if not os.path.isdir(label_path):
            continue
            
        # Scan images in this label's folder
        files = [f for f in os.listdir(label_path) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        if not files:
            continue
            
        print(f"Processing label [{label}] ({len(files)} images)...")
        
        for filename in files:
            total_images += 1
            path = os.path.join(label_path, filename)
            
            image = load_image(path)
            extracted = extract_landmarks(image)
            
            if extracted:
                if label not in model_data:
                    model_data[label] = []
                
                for hand in extracted:
                    model_data[label].append({
                        'handedness': hand['label'],
                        'landmarks': hand['landmarks']
                    })
                
                success_count += 1
            else:
                print(f"  - ❌ {filename}: No hands detected")

    # Save to model file
    with open('bisindo_model.json', 'w') as f:
        json.dump(model_data, f, indent=4)
    
    print(f"\n✨ ML Engine Training Complete!")
    print(f"   - Labels trained: {len(model_data)}")
    print(f"   - Images successful: {success_count}/{total_images}")
    print(f"   - Model saved to: bisindo_model.json")

if __name__ == "__main__":
    main()
