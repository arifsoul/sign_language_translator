// Global State
let hands;
let lastAudioBase64 = null;
let isDetecting = false;
let currentWord = "";
let lastLetterDetected = "";
let lastLetterTime = 0;
let bisindoModel = null;
let cameraStream = null;
let floatingPredictions = [];
let translationHistory = []; // { text, audio, timestamp }

// Shake Detection State
let wristHistory = [];
const SHAKE_WINDOW = 12; 
let SHAKE_SLIDER = 0.50; // 0-1 UI value
let SHAKE_THRESHOLD = 0.25; // Internal mapped value

// Active Interaction State
let virtualButtons = [];
let activeVBtn = null;
let vBtnStartTime = 0;
let lastVBtnClicked = null;
let vBtnArmed = true; 
const DWELL_TIME = 600; 

// Interactive Gesture State
let lastInteractiveGesture = "none";
let gestureDebounceTimer = 0;
const GESTURE_DEBOUNCE = 500; // ms

// Configuration
const FADE_SPEED = 0.04;
const LETTER_COOLDOWN = 1000; 
let MATCH_SLIDER = 0.50; // 0-1 UI value
let MATCH_THRESHOLD = 0.85; // Internal mapped value
let CONFIDENCE_THRESHOLD = 0.50; // 0-1 directly

// ... (rest of the file constants)
// I'll use multi_replace for specific parts instead to be safer with large file

// DOM Elements (Initialized in init())
let els = {};

async function init() {
    console.log("Initializing BISINDO Sense Dashboard...");
    
    // Bind Elements
    const ids = [
        'webcam', 'output_canvas', 'word-buffer', 
        'clear-buffer-btn', 'translate-btn', 'status-dot', 'status-text',
        'theme-toggle', 'backspace-btn', 'confidence-container', 
        'confidence-bar', 'confidence-value', 'shake-indicator',
        'model-badge', 'model-status', 'best-match-display', 
        'camera-toggle-btn', 'camera-toggle-dot', 
        'camera-status-text', 'virtual-cursor',
        'match-threshold-input', 'match-threshold-val',
        'shake-threshold-input', 'shake-threshold-val',
        'conf-threshold-input', 'conf-threshold-val',
        'word-buffer-container', 'open-settings-btn', 'close-settings-btn',
        'settings-modal', 'settings-backdrop', 'settings-content',
        'save-settings-btn', 'ai-notification-container', 'history-container',
        'history-count', 'history-empty-state', 'clear-history-btn',
        'speak-buffer-btn'
    ];
    
    ids.forEach(id => {
        els[id] = document.getElementById(id);
        if (!els[id]) console.warn(`Element not found: ${id}`);
    });

    if (els['theme-toggle']) initTheme();
    
    await fetchConfig(); // Load persistent thresholds
    
    if (els['camera-toggle-btn']) setupEventListeners();
    
    // Cache Virtual Button Rects
    window.addEventListener('resize', updateVBtnRects);
    setTimeout(updateVBtnRects, 1000);

    loadModel();
}

function updateVBtnRects() {
    const vBtnIds = ['backspace-btn', 'clear-buffer-btn', 'translate-btn'];
    const canvasRect = els['output_canvas'].getBoundingClientRect();
    
    virtualButtons = vBtnIds.map(id => {
        const el = els[id];
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
            id: id,
            el: el,
            progressEl: el.querySelector('.vbtn-progress'),
            x1: (rect.left - canvasRect.left) / canvasRect.width,
            y1: (rect.top - canvasRect.top) / canvasRect.height,
            x2: (rect.right - canvasRect.left) / canvasRect.width,
            y2: (rect.bottom - canvasRect.top) / canvasRect.height
        };
    }).filter(b => b !== null);
}

function setupEventListeners() {
    els['camera-toggle-btn'].addEventListener('click', () => {
        if (!isDetecting) startCamera();
        else stopCamera();
    });

    els['clear-buffer-btn'].addEventListener('click', () => {
        currentWord = "";
        els['word-buffer'].innerText = "-";
        lastLetterDetected = "";
        triggerVBtnHaptic(els['clear-buffer-btn']);
    });

    els['backspace-btn'].addEventListener('click', () => {
        if (currentWord.length > 0) {
            currentWord = currentWord.slice(0, -1);
            updateBufferUI();
        }
        triggerVBtnHaptic(els['backspace-btn']);
    });

    els['translate-btn'].addEventListener('click', () => {
        sendToBackend();
        triggerVBtnHaptic(els['translate-btn']);
    });

    // Threshold Event Listeners (Standardized 0-1 Mapping)
    els['match-threshold-input'].addEventListener('input', (e) => {
        MATCH_SLIDER = parseFloat(e.target.value);
        els['match-threshold-val'].innerText = MATCH_SLIDER.toFixed(2);
        MATCH_THRESHOLD = 1.5 - (MATCH_SLIDER * 1.0);
    });

    els['shake-threshold-input'].addEventListener('input', (e) => {
        SHAKE_SLIDER = parseFloat(e.target.value);
        els['shake-threshold-val'].innerText = SHAKE_SLIDER.toFixed(2);
        SHAKE_THRESHOLD = 0.05 + (SHAKE_SLIDER * 0.45);
    });

    els['conf-threshold-input'].addEventListener('input', (e) => {
        CONFIDENCE_THRESHOLD = parseFloat(e.target.value);
        els['conf-threshold-val'].innerText = CONFIDENCE_THRESHOLD.toFixed(2);
    });

    // Save config to server when user stops dragging
    ['match-threshold-input', 'shake-threshold-input', 'conf-threshold-input'].forEach(id => {
        els[id].addEventListener('change', saveConfig);
    });

    // ContentEditable Sync
    els['word-buffer'].addEventListener('input', (e) => {
        const newText = e.target.innerText;
        currentWord = newText === "-" ? "" : newText;
        updateBufferUI(false); // Update font size but don't re-render text
    });

    els['speak-btn']?.addEventListener('click', () => {
        if (lastAudioBase64) playAudio(lastAudioBase64);
    });

    // Settings Modal Toggles
    els['open-settings-btn'].addEventListener('click', toggleSettingsModal);
    els['close-settings-btn'].addEventListener('click', toggleSettingsModal);
    els['settings-backdrop'].addEventListener('click', toggleSettingsModal);
    els['save-settings-btn'].addEventListener('click', () => {
        saveConfig();
        toggleSettingsModal();
    });

    // History Logic
    els['clear-history-btn'].addEventListener('click', () => {
        translationHistory = [];
        updateHistoryUI();
    });

    // Buffer Speaker
    els['speak-buffer-btn'].addEventListener('click', async () => {
        if (!currentWord || currentWord === "-") return;
        
        try {
            const res = await fetch('/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gesture_name: currentWord })
            });
            const data = await res.json();
            if (data.audio_base64) playAudio(data.audio_base64);
        } catch (err) {
            console.error("TTS Failed:", err);
        }
    });
}

/**
 * Toggles the Settings Modal with animations
 */
function toggleSettingsModal() {
    const modal = els['settings-modal'];
    const backdrop = els['settings-backdrop'];
    const content = els['settings-content'];

    if (modal.classList.contains('hidden')) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => {
            backdrop.classList.add('opacity-100');
            content.classList.remove('translate-y-8', 'opacity-0');
        }, 10);
    } else {
        backdrop.classList.remove('opacity-100');
        content.classList.add('translate-y-8', 'opacity-0');
        setTimeout(() => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }, 300);
    }
}

/**
 * Shows a floating AI notification card over the canvas
 */
function showNotification(text, audioBase64 = null) {
    const container = els['ai-notification-container'];
    const id = 'note-' + Date.now();
    
    // Glassmorphism design (Transparent background, text only)
    const html = `
        <div id="${id}" class="px-8 py-6 rounded-[2rem] bg-white/10 dark:bg-black/20 backdrop-blur-xl border border-white/20 dark:border-white/5 shadow-2xl transition-all duration-700 translate-y-4 opacity-0 pointer-events-auto relative group/notif">
            <p class="text-xl font-bold leading-relaxed text-slate-800 dark:text-white tracking-tight text-center">
                ${text}
            </p>
        </div>
    `;
    
    container.insertAdjacentHTML('afterbegin', html);
    const el = document.getElementById(id);

    // Fade In
    setTimeout(() => {
        el.classList.remove('translate-y-4', 'opacity-0');
    }, 10);

    const dismiss = () => {
        if (!el.parentNode) return; // Already removed
        el.classList.add('translate-y-4', 'opacity-0', 'scale-95');
        setTimeout(() => el.remove(), 700);
    };

    // Sync with Audio if available
    if (audioBase64) {
        const audio = playAudio(audioBase64);
        if (audio) {
            audio.onended = () => {
                // Short delay after audio ends for better feel
                setTimeout(dismiss, 500);
            };
        } else {
            // Fallback if audio fails to create
            setTimeout(dismiss, 5000);
        }
    } else {
        // Fallback for text-only
        setTimeout(dismiss, 5000);
    }
}

/**
 * Updates the Translation History UI in the sidebar
 */
function updateHistoryUI() {
    const container = els['history-container'];
    const emptyState = els['history-empty-state'];
    const countBadge = els['history-count'];

    // Update count
    countBadge.innerText = translationHistory.length;

    if (translationHistory.length === 0) {
        container.innerHTML = '';
        container.appendChild(emptyState);
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    container.innerHTML = ''; // Clear previous
    
    translationHistory.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = "p-6 rounded-3xl bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/5 hover:border-primary-500/20 transition-all group/history relative animate-fade-in";
        div.innerHTML = `
            <p class="text-[0.65rem] font-medium leading-relaxed text-slate-600 dark:text-white/60 line-clamp-2 pr-12">
                ${item.text}
            </p>
            
            <div class="mt-4 flex items-center justify-between">
                <span class="text-[0.5rem] font-black text-slate-400 dark:text-white/10 uppercase tracking-widest">${item.timestamp}</span>
                <div class="flex items-center gap-2">
                    <button class="play-btn p-2 rounded-xl hover:bg-primary-500/10 text-primary-500 transition-colors">
                        <i data-lucide="volume-2" class="w-3.5 h-3.5"></i>
                    </button>
                    <button class="delete-btn p-2 rounded-xl hover:bg-red-500/10 text-red-400 transition-colors">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                </div>
            </div>
        `;
        
        div.querySelector('.play-btn').addEventListener('click', () => playAudio(item.audio));
        div.querySelector('.delete-btn').addEventListener('click', () => {
            translationHistory.splice(idx, 1);
            updateHistoryUI();
        });
        
        container.appendChild(div);
    });
    
    lucide.createIcons();
}

/**
 * Global helper to delete a history item (Legacy compatibility if needed)
 */
window.deleteHistoryItem = (index) => {
    translationHistory.splice(index, 1);
    updateHistoryUI();
};

function triggerVBtnHaptic(el) {
    el.classList.add('scale-90', 'bg-white/10');
    setTimeout(() => el.classList.remove('scale-90', 'bg-white/10'), 150);
}

// Theme Logic
function initTheme() {
    const html = document.documentElement;
    const theme = localStorage.getItem('theme');
    
    if (theme === 'light' || (!theme && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        html.classList.remove('dark');
        html.classList.add('light');
    } else {
        html.classList.add('dark');
        html.classList.remove('light');
    }

    els['theme-toggle'].addEventListener('click', () => {
        if (html.classList.contains('dark')) {
            html.classList.remove('dark');
            html.classList.add('light');
            localStorage.setItem('theme', 'light');
        } else {
            html.classList.add('dark');
            html.classList.remove('light');
            localStorage.setItem('theme', 'dark');
        }
        
        // Refresh Lucide icons if any were hidden/shown
        if (window.lucide) window.lucide.createIcons();
        
        // Update virtual button rectangles after a short delay for layout shift
        setTimeout(updateVBtnRects, 150);
    });
}

// Model Loading
async function loadModel() {
    try {
        console.log("Fetching model metadata...");
        if (els['model-status']) els['model-status'].innerText = "Loading Model...";
        
        const metaRes = await fetch('/metadata', { cache: 'no-cache' });
        if (!metaRes.ok) throw new Error("Metadata fetch failed");
        const metaData = await metaRes.json();
        
        console.log("Fetching model file...");
        const modelRes = await fetch('/bisindo_model.json', { cache: 'no-cache' });
        if (!modelRes.ok) throw new Error("Model file fetch failed");
        bisindoModel = await modelRes.json();
        
        console.log("Model successfully loaded.");
        if (els['model-badge']) {
            els['model-badge'].classList.remove('hidden');
            els['model-badge'].classList.add('flex');
        }
        if (els['model-status']) els['model-status'].innerText = `KNN Engine: ${metaData.count} Signs Active`;
        
    } catch (err) {
        console.error("Failed to load BISINDO model:", err);
        if (els['model-status']) {
            els['model-status'].innerText = "Model Error";
        }
    }
}

function updateStatus(state, message) {
    if (!els['status-text'] || !els['status-dot']) return;
    els['status-text'].innerText = message.toUpperCase();
    els['status-dot'].className = 'w-2.5 h-2.5 rounded-full transition-all duration-300 ';
    if (state === 'active') {
        els['status-dot'].classList.add('bg-emerald-500', 'shadow-[0_0_15px_#10b981]');
    } else if (state === 'processing') {
        els['status-dot'].classList.add('bg-amber-500', 'shadow-[0_0_15px_#f59e0b]');
    } else {
        els['status-dot'].classList.add('bg-red-500', 'shadow-[0_0_15px_#ef4444]');
    }
}

function onResults(results) {
    const canvasCtx = els['output_canvas'].getContext('2d');
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, els['output_canvas'].width, els['output_canvas'].height);
    
    // Draw mirrored video
    canvasCtx.translate(els['output_canvas'].width, 0);
    canvasCtx.scale(-1, 1);
    canvasCtx.drawImage(results.image, 0, 0, els['output_canvas'].width, els['output_canvas'].height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        results.multiHandLandmarks.forEach((landmarks, index) => {
            const isLeft = results.multiHandedness[index].label === 'Left';
            const color = isLeft ? '#f43f5e' : '#0ea5e9';
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: color, lineWidth: 4});
            drawLandmarks(canvasCtx, landmarks, {color: '#ffffff', lineWidth: 1, radius: 3});
        });

        // Precise Index Fingertip Tracking (Landmark 8)
        let activeHandIndex = 0;
        
        // If multiple hands, pick the one closer to the virtual buttons (top-right area)
        if (results.multiHandLandmarks.length > 1) {
            const h1 = results.multiHandLandmarks[0][8];
            const h2 = results.multiHandLandmarks[1][8];
            // Since buttons are on the right (high x in mirrored space, so low x in mediapipe space)
            // But we use 1-x for screen space. Let's just pick the one with better visibility.
            // Usually, the first hand in onResults is the most prominent one.
            activeHandIndex = (1 - h2.x > 1 - h1.x) ? 1 : 0;
        }

        const activeLandmarks = results.multiHandLandmarks[activeHandIndex];
        const indexTip = activeLandmarks[8];
        const isLeft = results.multiHandedness[activeHandIndex].label === 'Left';
        
        const cursorX = (1 - indexTip.x) * 100;
        const cursorY = indexTip.y * 100;
        
        if (els['virtual-cursor']) {
            els['virtual-cursor'].style.opacity = "1";
            els['virtual-cursor'].style.left = `${cursorX}%`;
            els['virtual-cursor'].style.top = `${cursorY}%`;
            
            // Reversed Color Logic: Red Hand -> Blue Tip, Blue Hand -> Red Tip
            const tipEl = document.getElementById('cursor-tip');
            const ringEl = els['virtual-cursor'].firstElementChild;
            
            if (isLeft) {
                // Hand is Red (Left) -> Cursor is Blue
                if (tipEl) tipEl.style.backgroundColor = '#0ea5e9';
                if (ringEl) ringEl.style.borderColor = '#0ea5e9';
            } else {
                // Hand is Blue (Right) -> Cursor is Red
                if (tipEl) tipEl.style.backgroundColor = '#f43f5e';
                if (ringEl) ringEl.style.borderColor = '#f43f5e';
            }
        }

        checkVirtualCollisions(indexTip);

        if (bisindoModel) {
            detectBisindoModel(results.multiHandWorldLandmarks, results.multiHandedness);
            
            // Handle Interactive Gestures (UI Control)
            const gesture = detectInteractiveGestures(results.multiHandWorldLandmarks[activeHandIndex]);
            handleInteractiveActions(gesture);
        }
    } else {
        els['confidence-container'].classList.add('opacity-0', 'translate-y-4');
        if (els['virtual-cursor']) els['virtual-cursor'].style.opacity = "0";
        wristHistory = []; 
        resetVBtnState();
    }

    canvasCtx.restore();
    canvasCtx.save();

    floatingPredictions = floatingPredictions.filter(p => p.opacity > 0);
    floatingPredictions.forEach(p => {
        canvasCtx.globalAlpha = p.opacity;
        canvasCtx.fillStyle = '#0ea5e9'; 
        canvasCtx.shadowColor = 'rgba(0,0,0,0.3)';
        canvasCtx.shadowBlur = 15;
        canvasCtx.font = '900 120px "Plus Jakarta Sans"';
        canvasCtx.textAlign = 'center';
        
        const drawX = (1 - p.x) * els['output_canvas'].width;
        const jitter = p.isLocking ? (Math.random() - 0.5) * 20 : 0;
        canvasCtx.fillText(p.text, drawX + jitter, p.y * els['output_canvas'].height);
        
        p.opacity -= FADE_SPEED;
        p.y -= 0.006; 
    });
    canvasCtx.globalAlpha = 1.0;
    canvasCtx.restore();
}

function checkVirtualCollisions(point) {
    let hoveredBtn = null;
    
    // point.x is normalized 0-1 (mirrored in video, so we use it as-is for screen-space matching if buttons are absolute)
    // Actually, buttons are fixed to the right of the screen. 
    // MediaPipe point.x is 0 (left) to 1 (right). Video is mirrored.
    // So 0.1 in MediaPipe is physically on the right of the sensor, which is left on screen if mirrored.
    // Let's use 1-point.x for screen space X.
    const screenX = 1 - point.x;
    const screenY = point.y;

    for (const btn of virtualButtons) {
        if (screenX >= btn.x1 && screenX <= btn.x2 && screenY >= btn.y1 && screenY <= btn.y2) {
            hoveredBtn = btn;
            break;
        }
    }

    if (hoveredBtn) {
        if (activeVBtn !== hoveredBtn) {
            resetVBtnState();
            activeVBtn = hoveredBtn;
            vBtnStartTime = Date.now();
            
            // If we just clicked this button (specifically Backspace), 
            // we must 'disarm' until we exit and re-enter.
            if (activeVBtn.id === 'backspace-btn' && lastVBtnClicked === 'backspace-btn') {
                vBtnArmed = false;
            } else {
                vBtnArmed = true;
            }

            activeVBtn.el.classList.add('bg-white/10', 'border-primary-500/60', 'scale-105');
        } else {
            if (!vBtnArmed) return; // Wait for exit

            const elapsed = Date.now() - vBtnStartTime;
            const progress = Math.min(100, (elapsed / DWELL_TIME) * 100);
            if (activeVBtn.progressEl) activeVBtn.progressEl.style.width = `${progress}%`;
            
            if (elapsed >= DWELL_TIME) {
                activeVBtn.el.click(); // Trigger actual event listener
                lastVBtnClicked = activeVBtn.id;
                vBtnArmed = false; // Disarm immediately after click
                resetVBtnState(); 
            }
        }
    } else {
        if (activeVBtn) {
            // If we exit a button, we are armed again for the next one
            vBtnArmed = true;
            lastVBtnClicked = null;
        }
        resetVBtnState();
    }
}

function resetVBtnState() {
    if (activeVBtn) {
        activeVBtn.el.classList.remove('bg-white/10', 'border-primary-500/60', 'scale-105');
        if (activeVBtn.progressEl) activeVBtn.progressEl.style.width = '0%';
    }
    activeVBtn = null;
}

function normalizeLandmarks(landmarks) {
    const rawPts = landmarks.map(lm => ({x: lm.x, y: lm.y, z: lm.z}));
    const wrist = rawPts[0];
    const centered = rawPts.map(pt => ({
        x: pt.x - wrist.x,
        y: pt.y - wrist.y,
        z: pt.z - wrist.z
    }));
    let maxDist = 0;
    centered.forEach(pt => {
        const d = Math.sqrt(pt.x*pt.x + pt.y*pt.y + pt.z*pt.z);
        if (d > maxDist) maxDist = d;
    });
    if (maxDist === 0) maxDist = 1;
    return centered.map(pt => ({
        x: pt.x / maxDist,
        y: pt.y / maxDist,
        z: pt.z / maxDist
    }));
}

/**
 * Detects UI-control gestures (Fist, Thumbs Up, Thumbs Down)
 * based on World Landmarks (Metric space).
 */
function detectInteractiveGestures(landmarks) {
    if (!landmarks || landmarks.length < 21) return "none";
    
    try {
        // Wrist is [0]
        const wrist = landmarks[0];
        
        // Ported logic from clasify_gesture.py adapted for World Landmarks
        // Metric coordinates are in meters
        
        // 1. Calculate Distances
        const getDist = (a, b) => {
            return Math.sqrt(
                Math.pow(a.x - b.x, 2) + 
                Math.pow(a.y - b.y, 2) + 
                Math.pow(a.z - b.z, 2)
            );
        };

        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const pinkyTip = landmarks[20];
        const thumbMCP = landmarks[2];

        const thumbIndexDist = getDist(thumbTip, indexTip);
        const thumbPinkyDist = getDist(thumbTip, pinkyTip);

        // FIST: Thumb is relatively close to index and pinky (curled in)
        // Relaxed from 0.25/0.35 to 0.45 for better reliability
        if (thumbIndexDist < 0.45 && thumbPinkyDist < 0.55) {
            return "fist";
        }

        // THUMBS UP: Thumb tip is above Thumb MCP (Y is negative up)
        // Relaxed Y threshold further to 0.12 for easier detection
        if (thumbTip.y < thumbMCP.y - 0.12) {
            return "thumbs_up";
        }

        // THUMBS DOWN: Thumb tip is below Thumb MCP
        // Relaxed Y threshold further to 0.12
        if (thumbTip.y > thumbMCP.y + 0.12) {
            return "thumbs_down";
        }

        return "none";
    } catch (e) {
        console.error("Gesture detection error:", e);
        return "none";
    }
}

function handleInteractiveActions(gesture) {
    if (gesture === "none" || gesture === lastInteractiveGesture) {
        if (gesture === "none") lastInteractiveGesture = "none";
        return;
    }

    const now = Date.now();
    if (now - gestureDebounceTimer < GESTURE_DEBOUNCE) return;

    // Trigger actions based on gesture
    if (gesture === "fist") {
        if (!currentWord || currentWord === "-") {
            // console.log("✊ Fist detected, but buffer is empty. Skipping.");
            return;
        }
        console.log("✊ Fist detected: Translating...");
        els['translate-btn'].click();
        triggerVBtnHaptic(els['translate-btn']);
    } else if (gesture === "thumbs_up") {
        console.log("👍 Thumbs Up detected: Resetting...");
        els['clear-buffer-btn'].click();
        triggerVBtnHaptic(els['clear-buffer-btn']);
    } else if (gesture === "thumbs_down") {
        console.log("👎 Thumbs Down detected: Backspace...");
        els['backspace-btn'].click();
        triggerVBtnHaptic(els['backspace-btn']);
    }

    lastInteractiveGesture = gesture;
    gestureDebounceTimer = now;
}

function calculateDistance(l1, l2) {
    let sum = 0;
    for (let i = 0; i < 21; i++) {
        sum += Math.sqrt(
            Math.pow(l1[i].x - l2[i].x, 2) +
            Math.pow(l1[i].y - l2[i].y, 2) +
            Math.pow(l1[i].z - l2[i].z, 2)
        );
    }
    return sum / 21;
}

function detectBisindoModel(multiWorldLandmarks, multiHandedness) {
    if (!bisindoModel || !multiWorldLandmarks) return;

    // 1. Shake Detection logic
    let maxHandDisplacement = 0;
    multiWorldLandmarks.forEach((landmarks, handIdx) => {
        const wrist = landmarks[0];
        if (!wristHistory[handIdx]) wristHistory[handIdx] = [];
        wristHistory[handIdx].push({x: wrist.x, y: wrist.y});
        if (wristHistory[handIdx].length > SHAKE_WINDOW) wristHistory[handIdx].shift();

        if (wristHistory[handIdx].length === SHAKE_WINDOW) {
            let displacement = 0;
            for (let i = 1; i < wristHistory[handIdx].length; i++) {
                displacement += Math.sqrt(
                    Math.pow(wristHistory[handIdx][i].x - wristHistory[handIdx][i-1].x, 2) +
                    Math.pow(wristHistory[handIdx][i].y - wristHistory[handIdx][i-1].y, 2)
                );
            }
            maxHandDisplacement = Math.max(maxHandDisplacement, displacement);
        }
    });

    const isShaking = maxHandDisplacement > SHAKE_THRESHOLD;
    if (els['shake-indicator']) {
        els['shake-indicator'].style.opacity = isShaking ? "1" : "0";
    }

    if (activeVBtn) return;

    // 2. KNN Sign Detection
    let bestMatch = null;
    let minScore = Infinity;
    const K = 3; 

    const currentHands = multiHandedness.map((h, i) => ({
        label: h.label.toLowerCase(),
        landmarks: normalizeLandmarks(multiWorldLandmarks[i])
    }));

    if (currentHands.length === 0) return;

    // Flatten all samples from all labels for comparison
    const neighbors = [];
    for (const [label, samples] of Object.entries(bisindoModel)) {
        samples.forEach(sample => {
            // Find current hand with same handedness
            const hand = currentHands.find(h => h.label === sample.handedness);
            if (hand) {
                const dist = calculateDistance(hand.landmarks, sample.landmarks);
                neighbors.push({ label, dist });
            }
        });
    }

    if (neighbors.length > 0) {
        neighbors.sort((a, b) => a.dist - b.dist);
        const topK = neighbors.slice(0, K);
        
        // Weighted voting
        const votes = {};
        topK.forEach(n => {
            const weight = 1 / (n.dist + 0.001);
            votes[n.label] = (votes[n.label] || 0) + weight;
        });

        let winner = null;
        let maxVotes = 0;
        for (const [lbl, v] of Object.entries(votes)) {
            if (v > maxVotes) {
                maxVotes = v;
                winner = lbl;
            }
        }

        minScore = topK[0].dist; // Use closest neighbor for confidence
        bestMatch = winner;
    }

    // 3. Update UI and Handle Shake Triggers
    const HUD_THRESHOLD = MATCH_THRESHOLD * 1.5;
    if (bestMatch && minScore < HUD_THRESHOLD) { 
        const confidence = Math.max(0, Math.min(100, Math.round((1 - minScore / HUD_THRESHOLD) * 100)));
        
        // Only show HUD if confidence exceeds user-set threshold
        if (confidence >= CONFIDENCE_THRESHOLD * 100) {
            els['confidence-container'].classList.remove('opacity-0', 'translate-y-4');
            els['confidence-bar'].style.width = `${confidence}%`;
            els['confidence-value'].innerText = `${confidence}%`;
            els['best-match-display'].innerText = bestMatch;
        } else {
            els['confidence-container'].classList.add('opacity-0', 'translate-y-4');
        }
        
        // Match threshold for "locking" is tighter than just seeing it on HUD
        if (isShaking && minScore < MATCH_THRESHOLD) {
            const now = Date.now();
            if (now - lastLetterTime > LETTER_COOLDOWN || lastLetterDetected !== bestMatch) {
                addLetterToBuffer(bestMatch);
                
                // Visual feedback for locking
                const centerX = multiWorldLandmarks[0].reduce((s, l) => s + l.x, 0) / 21;
                const centerY = multiWorldLandmarks[0].reduce((s, l) => s + l.y, 0) / 21;
                floatingPredictions.push({
                    text: bestMatch,
                    x: centerX,
                    y: centerY,
                    opacity: 1.0,
                    isLocking: true
                });
                lastLetterDetected = bestMatch;
                lastLetterTime = now;
            }
        }
    } else {
        els['confidence-container'].classList.add('opacity-0', 'translate-y-4');
    }
}

function addLetterToBuffer(letter) {
    if (currentWord === "-" || currentWord === "") currentWord = "";
    currentWord += letter;
    updateBufferUI();
}

/**
 * Updates the Word Buffer UI with dynamic font scaling and auto-scroll
 * @param {boolean} updateText - Whether to update the innerText (false for manual edits)
 */
function updateBufferUI(updateText = true) {
    const buffer = els['word-buffer'];
    const container = els['word-buffer-container'];
    
    if (updateText) {
        buffer.innerText = currentWord || "-";
    }

    const length = currentWord.length;
    
    // Dynamic Font Scaling
    // Default 6xl (3.75rem / 60px). Shrink as text gets longer.
    let fontSize = 60; 
    if (length > 10) fontSize = 48; // 3rem
    if (length > 20) fontSize = 36; // 2.25rem
    if (length > 40) fontSize = 28; // 1.75rem
    if (length > 60) fontSize = 20; // 1.25rem
    
    buffer.style.fontSize = `${fontSize}px`;
    
    // Auto-scroll to bottom
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 10);

    // Visual feedback
    buffer.classList.add('scale-105', 'text-primary-400');
    setTimeout(() => buffer.classList.remove('scale-105', 'text-primary-400'), 200);
}

/**
 * Fetches threshold configuration from the backend
 */
async function fetchConfig() {
    try {
        const response = await fetch('/config');
        const data = await response.json();
        
        // Update Sliders
        els['match-threshold-input'].value = data.match;
        els['shake-threshold-input'].value = data.shake;
        els['conf-threshold-input'].value = data.confidence;
        
        // Trigger UI updates
        els['match-threshold-val'].innerText = parseFloat(data.match).toFixed(2);
        els['shake-threshold-val'].innerText = parseFloat(data.shake).toFixed(2);
        els['conf-threshold-val'].innerText = parseFloat(data.confidence).toFixed(2);
        
        // Apply internal mapping
        MATCH_SLIDER = data.match;
        SHAKE_SLIDER = data.shake;
        CONFIDENCE_THRESHOLD = data.confidence;
        
        MATCH_THRESHOLD = 1.5 - (MATCH_SLIDER * 1.0);
        SHAKE_THRESHOLD = 0.05 + (SHAKE_SLIDER * 0.45);
        
    } catch (e) {
        console.error("Failed to fetch config:", e);
    }
}

/**
 * Saves current threshold configuration to the backend
 */
async function saveConfig() {
    try {
        await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                match: MATCH_SLIDER,
                shake: SHAKE_SLIDER,
                confidence: CONFIDENCE_THRESHOLD
            })
        });
    } catch (e) {
        console.error("Failed to save config:", e);
    }
}

async function sendToBackend() {
    if (!currentWord || currentWord === "-") return;
    
    updateStatus('processing', 'Menerjemahkan...');
    
    try {
        const response = await fetch('/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gesture_name: currentWord }),
        });
        
        const data = await response.json();
        
        if (data.translated_text) {
            // Show Notification
            showNotification(data.translated_text, data.audio_base64);
            
            // Add to History
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            translationHistory.unshift({
                text: data.translated_text,
                audio: data.audio_base64,
                timestamp: timestamp
            });
            updateHistoryUI();
        }
        
        lastAudioBase64 = data.audio_base64;
        updateStatus('active', 'Terjemahan Selesai');
        
    } catch (error) {
        console.error("Translation Error:", error);
        updateStatus('idle', 'Gagal Menerjemahkan');
    }
}

function playAudio(base64) {
    if (!base64) return null;
    try {
        const audio = new Audio("data:audio/mp3;base64," + base64);
        audio.play();
        return audio;
    } catch (e) {
        console.error("Audio Playback Error:", e);
        return null;
    }
}

async function startCamera() {
    updateStatus('processing', 'Meminta Kamera...');
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
        els['webcam'].srcObject = cameraStream;
        els['webcam'].onloadedmetadata = () => {
            els['output_canvas'].width = els['webcam'].videoWidth;
            els['output_canvas'].height = els['webcam'].videoHeight;
            updateVBtnRects();
            initMediaPipe();
        };
        
        els['camera-toggle-btn'].classList.replace('bg-white/5', 'bg-primary-500');
        els['camera-toggle-dot'].classList.add('translate-x-5');
        els['camera-toggle-dot'].classList.replace('bg-white/30', 'bg-white');
        els['camera-status-text'].innerText = "Kamera Aktif";
        isDetecting = true;
    } catch (err) {
        console.error("Error:", err);
        updateStatus('inactive', 'Gagal Kamera');
        resetToggleUI();
    }
}

function stopCamera() {
    isDetecting = false;
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    els['webcam'].srcObject = null;
    const canvasCtx = els['output_canvas'].getContext('2d');
    canvasCtx.clearRect(0, 0, els['output_canvas'].width, els['output_canvas'].height);
    updateStatus('inactive', 'Kamera Mati');
    resetToggleUI();
}

function resetToggleUI() {
    els['camera-toggle-btn'].classList.replace('bg-primary-500', 'bg-white/5');
    els['camera-toggle-dot'].classList.remove('translate-x-5');
    els['camera-toggle-dot'].classList.replace('bg-white', 'bg-white/30');
    els['camera-status-text'].innerText = "Kamera Off";
}

function initMediaPipe() {
    if (!hands) {
        hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.7
        });
        hands.onResults(onResults);
    }
    
    async function processFrame() {
        if (isDetecting && els['webcam'].readyState >= 2) {
            await hands.send({image: els['webcam']});
            requestAnimationFrame(processFrame);
        }
    }
    updateStatus('active', 'Deteksi Aktif');
    processFrame();
}

document.addEventListener('DOMContentLoaded', init);
