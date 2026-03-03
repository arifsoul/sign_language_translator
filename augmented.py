import cv2
import os
import glob
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import json
from pathlib import Path

# Setup MediaPipe Hands using Tasks API
base_options = python.BaseOptions(model_asset_path='hand_landmarker.task')
options = vision.HandLandmarkerOptions(
    base_options=base_options,
    num_hands=1,
    min_hand_detection_confidence=0.5,
    min_tracking_confidence=0.5
)
detector = vision.HandLandmarker.create_from_options(options)

# Constants
DATASET_DIR = "bisindo_dataset"
MODEL_FILE = "bisindo_model.json"

# Augmentation Configuration
NUM_VARIATIONS = 50        # Includes the original (e.g., 20 means 1 original + 19 augmented)
GUARANTEE_MIRROR = True    # Ensure at least one variation is a horizontally flipped (mirrored) version

# Ranges for randomization
ROTATION_RANGE = (-15, 15) # Degrees
SCALE_RANGE = (0.9, 1.1)   # Multiplier (e.g. 0.9 = 90% size)
TRANS_RANGE = (-20, 20)    # Pixels to shift X and Y
PERSP_JITTER = 0.05        # Percentage of image width for perspective corner jitter
MIRROR_CHANCE = 0.1        # Probability of a random variation being mirrored (if GUARANTEE_MIRROR is False or already fulfilled)

def augment_image(image, index):
    """
    Applies random geometric transformations to generate an augmented image.
    index 0 is reserved for the original image.
    """
    if index == 0:
        return image
        
    h, w = image.shape[:2]
    center = (w // 2, h // 2)

    # 1. Random Rotation (from configured range)
    angle = np.random.uniform(ROTATION_RANGE[0], ROTATION_RANGE[1])
    
    # 2. Random Scale (from configured range)
    scale = np.random.uniform(SCALE_RANGE[0], SCALE_RANGE[1])
    
    # 3. Random Translation (from configured range)
    tx = np.random.uniform(TRANS_RANGE[0], TRANS_RANGE[1])
    ty = np.random.uniform(TRANS_RANGE[0], TRANS_RANGE[1])

    # Get rotation matrix
    M_rot = cv2.getRotationMatrix2D(center, angle, scale)
    
    # Add translation to the matrix
    M_rot[0, 2] += tx
    M_rot[1, 2] += ty

    # Apply affine transformation (Rotation + Scale + Translation)
    # Use BORDER_REPLICATE to avoid black edges when shifting
    augmented = cv2.warpAffine(image, M_rot, (w, h), borderMode=cv2.BORDER_REPLICATE)
    
    # 4. Perspective Warp (simulate slight 3D camera angle shift)
    # Randomly jitter the 4 corners
    margin = int(w * PERSP_JITTER)
    pts1 = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    pts2 = np.float32([
        [0 + np.random.randint(-margin, margin), 0 + np.random.randint(-margin, margin)],
        [w + np.random.randint(-margin, margin), 0 + np.random.randint(-margin, margin)],
        [0 + np.random.randint(-margin, margin), h + np.random.randint(-margin, margin)],
        [w + np.random.randint(-margin, margin), h + np.random.randint(-margin, margin)]
    ])
    
    M_persp = cv2.getPerspectiveTransform(pts1, pts2)
    augmented = cv2.warpPerspective(augmented, M_persp, (w, h), borderMode=cv2.BORDER_REPLICATE)
    
    # 5. Mirroring Logic.
    # Note: If guaranteed mirror is requested, the logic in main() will pass a specific flag
    # Custom kwarg `force_mirror` could be used, but for simplicity we'll handle it during 
    # the loop. Let's add it to the signature dynamically.
    return augmented

def apply_mirror(image):
    """Explicitly applies a horizontal flip."""
    return cv2.flip(image, 1)

def normalize_landmarks(landmarks):
    """
    Zero-centers the landmarks array based on the wrist (index 0)
    and scales them by the maximum distance.
    (Keeps consistency with the frontend/backend mechanism)
    """
    wrist = landmarks[0]
    centered = [{'x': lm['x'] - wrist['x'], 'y': lm['y'] - wrist['y'], 'z': lm['z'] - wrist['z']} for lm in landmarks]
    
    max_dist = 0
    for lm in centered:
        dist = (lm['x']**2 + lm['y']**2 + lm['z']**2) ** 0.5
        if dist > max_dist:
            max_dist = dist
            
    if max_dist == 0:
        return centered
        
    normalized = [{'x': lm['x'] / max_dist, 'y': lm['y'] / max_dist, 'z': lm['z'] / max_dist} for lm in centered]
    return normalized

def extract_landmarks(image):
    """Runs mediapipe over an image and returns the normalized landmarks."""
    img_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
    
    results = detector.detect(mp_image)
    
    if not results.hand_landmarks:
        return None
        
    # Take the first hand found
    hand_landmarks = results.hand_landmarks[0]
    
    landmarks = []
    for lm in hand_landmarks:
         landmarks.append({'x': lm.x, 'y': lm.y, 'z': lm.z})
         
    return normalize_landmarks(landmarks)

def main():
    print(f"Starting Data Augmentation pipeline...")
    print(f"Target: {NUM_VARIATIONS} variations per class.")
    
    if not os.path.exists(DATASET_DIR):
        print(f"Error: Directory '{DATASET_DIR}' not found.")
        return

    model_data = {}
    total_images_generated = 0
    total_landmarks_extracted = 0

    # Cleanup old augmented files first
    old_augments = glob.glob(os.path.join(DATASET_DIR, "**", "*_aug*.png"), recursive=True)
    if old_augments:
        print(f"Cleaning up {len(old_augments)} previous augmented images...")
        for old_file in old_augments:
            try:
                os.remove(old_file)
            except Exception as e:
                print(f"  [!] Failed to delete {old_file}: {e}")

    # Iterate through each character subdirectory
    for char_dir in os.listdir(DATASET_DIR):
        dir_path = os.path.join(DATASET_DIR, char_dir)
        if not os.path.isdir(dir_path):
            continue

        print(f"\nProcessing class '{char_dir}'...")
        
        # Find the original image. Since we deleted old *_aug*.png, everything left should be base images.
        # But we still double check just in case of typos.
        image_files = [f for f in glob.glob(os.path.join(dir_path, '*.*')) if not '_aug' in os.path.basename(f) and f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        
        if not image_files:
            print(f"  [!] No base image found in {dir_path}")
            continue
            
        base_img_path = image_files[0]
        base_img = cv2.imread(base_img_path)
        
        if base_img is None:
            print(f"  [!] Could not read image {base_img_path}")
            continue

        class_landmarks = []
        
        # Determine the base filename for naming augments
        base_name = os.path.splitext(os.path.basename(base_img_path))[0]
        
        # We need a mirror slot if GUARANTEE_MIRROR is True
        mirror_slot = np.random.randint(1, NUM_VARIATIONS) if GUARANTEE_MIRROR and NUM_VARIATIONS > 1 else -1

        for i in range(NUM_VARIATIONS):
            # 1. Generate Image
            if i == 0:
                aug_img = base_img.copy()
            else:
                aug_img = augment_image(base_img.copy(), i)
                
                # Apply mirroring occasionally, OR guarantee it on the chosen slot
                is_mirror_slot = (i == mirror_slot)
                if is_mirror_slot or np.random.random() < MIRROR_CHANCE:
                    aug_img = apply_mirror(aug_img)
            
            # 2. Extract Landmarks (Skip saving if hand is not detected)
            landmarks = extract_landmarks(aug_img)
            
            if landmarks:
                class_landmarks.append(landmarks)
                total_landmarks_extracted += 1
                
                # 3. Save Image
                if i > 0:
                    out_name = f"{base_name}_aug{i}.png"
                    out_path = os.path.join(dir_path, out_name)
                    cv2.imwrite(out_path, aug_img)
                    total_images_generated += 1
            else:
                print(f"  [!] Warning: No hand detected in variation {i} for '{char_dir}'. Skipping save.")

        # Save all successful landmarks for this class to the model dictionary
        if class_landmarks:
            model_data[char_dir] = class_landmarks
            print(f"  => Successfully extracted {len(class_landmarks)}/{NUM_VARIATIONS} landmarks.")
        else:
            print(f"  => FAILED entirely for '{char_dir}'.")

    # Save to JSON
    print(f"\nSaving {total_landmarks_extracted} total landmarks to {MODEL_FILE}...")
    with open(MODEL_FILE, 'w') as f:
        json.dump(model_data, f, indent=4)
        
    print(f"Done. Generated {total_images_generated} augmented images.")

if __name__ == "__main__":
    main()
