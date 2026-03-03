
import cv2
import mediapipe as mp
import numpy as np

# Initialize MediaPipe Hands
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.8,
    min_tracking_confidence=0.8
)
mp_draw = mp.solutions.drawing_utils

# Function to classify basic gestures
def classify_gesture(landmarks):
    """
    Classifies hand gestures: Thumbs Up, Thumbs Down, and Fist
    """
    try:
        # Normalize using wrist as reference
        wrist = landmarks[0]
        
        # Normalize coordinates
        normalized_landmarks = np.array([
            [(lm.x - wrist.x), (lm.y - wrist.y)] for lm in landmarks
        ])

        # Distance calculations
        thumb_index_dist = np.linalg.norm(normalized_landmarks[4] - normalized_landmarks[8])
        thumb_pinky_dist = np.linalg.norm(normalized_landmarks[4] - normalized_landmarks[20])

        # **Gesture Classification**
        # Fist → All fingers are close together
        if thumb_index_dist < 0.1 and thumb_pinky_dist < 0.2:
            return "Fist "

        # Thumbs Up → Thumb above MCP joint
        elif normalized_landmarks[4][1] < normalized_landmarks[2][1]:
            return "Thumbs Up "

        # Thumbs Down → Thumb below MCP joint
        elif normalized_landmarks[4][1] > normalized_landmarks[2][1]:
            return "Thumbs Down "

        else:
            return "Unknown"
    except Exception as e:
        print(f"Error in classification: {e}")
        return "Unknown"