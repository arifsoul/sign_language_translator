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
let shakeHistory = [ [], [] ]; // array of wrist points for each hand to detect shake
let pendingPrediction = ""; // the character predicted by AI waiting for confirmation
let currentContinuousPrediction = ""; // Current raw prediction from backend
let continuousPredictionStartTime = 0; // Timestamp when currentContinuousPrediction started
let isWaitingForShake = false; // Flag to indicate we are stabilized and waiting for shake
let isFetchingPrediction = false; // Prevent overlapping API calls

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
let isGestureArmed = false; // Safety lock
let isSignModeActive = false; // Real-time Sign Mode
const GESTURE_DEBOUNCE = 500; // ms

// Configuration
const FADE_SPEED = 0.04;
const LETTER_COOLDOWN = 1200; 
let MATCH_SLIDER = 0.50; // 0-1 UI value
let MATCH_THRESHOLD = 0.85; // Internal mapped value
let SHAKE_SLIDER = 0.50; // 0-1 UI value
let K_NEIGHBORS = 5; // KNN value

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
        'best-match-display', 'camera-toggle-btn', 'camera-toggle-dot', 
        'camera-status-text', 'virtual-cursor',
        'match-threshold-input', 'match-threshold-val',
        'shake-threshold-input', 'shake-threshold-val',
        'k-neighbors-input', 'k-neighbors-val',
        'word-buffer-container', 'open-settings-btn', 'close-settings-btn',
        'settings-modal', 'settings-backdrop', 'settings-content',
        'save-settings-btn', 'ai-notification-container', 'history-container',
        'history-count', 'history-empty-state', 'clear-history-btn',
        'speak-buffer-btn', 'mode-status-text', 'mode-badge'
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
    updateModeUI();
}

/**
 * Updates the persistent Mode Indicator badge
 */
function updateModeUI() {
    const textEl = els['mode-status-text'];
    const badgeEl = els['mode-badge'];
    if (!textEl || !badgeEl) return;

    if (isSignModeActive) {
        textEl.innerText = "SIGN MODE";
        textEl.className = "text-[0.6rem] font-black tracking-widest text-emerald-500 uppercase";
        badgeEl.className = "flex items-center gap-2 px-3 py-1 bg-emerald-500/5 rounded-full border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.1)]";
    } else if (isGestureArmed) {
        textEl.innerText = "ARMED";
        textEl.className = "text-[0.6rem] font-black tracking-widest text-primary-500 uppercase";
        badgeEl.className = "flex items-center gap-2 px-3 py-1 bg-primary-500/5 rounded-full border border-primary-500/20";
    } else {
        textEl.innerText = "LOCKED";
        textEl.className = "text-[0.6rem] font-black tracking-widest text-slate-400 dark:text-white/30 uppercase";
        badgeEl.className = "flex items-center gap-2 px-3 py-1 bg-slate-100 dark:bg-white/5 rounded-full border border-slate-200 dark:border-white/5";
    }
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
    if (els['match-threshold-input']) {
        els['match-threshold-input'].addEventListener('input', (e) => {
            MATCH_SLIDER = parseFloat(e.target.value);
            els['match-threshold-val'].innerText = MATCH_SLIDER.toFixed(2);
            MATCH_THRESHOLD = 1.5 - (MATCH_SLIDER * 1.0);
        });
        // Save config to server when user stops dragging
        els['match-threshold-input'].addEventListener('change', saveConfig);
    }
    
    if (els['shake-threshold-input']) {
        els['shake-threshold-input'].addEventListener('input', (e) => {
            SHAKE_SLIDER = parseFloat(e.target.value);
            els['shake-threshold-val'].innerText = SHAKE_SLIDER.toFixed(2);
        });
        els['shake-threshold-input'].addEventListener('change', saveConfig);
    }

    if (els['k-neighbors-input']) {
        els['k-neighbors-input'].addEventListener('input', (e) => {
            K_NEIGHBORS = parseInt(e.target.value);
            els['k-neighbors-val'].innerText = K_NEIGHBORS;
        });
        els['k-neighbors-input'].addEventListener('change', saveConfig);
    }

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
        sendToBackend();
        triggerVBtnHaptic(els['speak-buffer-btn']);
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
            detectBisindoModel(results.multiHandWorldLandmarks, results.multiHandedness, activeHandIndex);
            
            // Check for Double Horn to Exit Sign Mode
            if (isSignModeActive && results.multiHandWorldLandmarks.length === 2) {
                const horn1 = detectInteractiveGestures(normalizeLandmarks(results.multiHandWorldLandmarks[0])) === "metal_horn";
                const horn2 = detectInteractiveGestures(normalizeLandmarks(results.multiHandWorldLandmarks[1])) === "metal_horn";
                
                if (horn1 && horn2) {
                    const now = Date.now();
                    if (now - gestureDebounceTimer > GESTURE_DEBOUNCE) {
                        console.log("🤘🤘 DOUBLE HORN detected: Exiting Sign Mode...");
                        isSignModeActive = false;
                        isGestureArmed = true; // Drop back to Armed state
                        showNotification("Sign Mode: OFF 🛑");
                        updateModeUI();
                        gestureDebounceTimer = now;
                    }
                }
            }
            
            // Handle Interactive Gestures (UI Control)
            // Fix: Normalize before detection to ensure scale-invariant thresholds
            const normLandmarks = normalizeLandmarks(results.multiHandWorldLandmarks[activeHandIndex]);
            const gesture = detectInteractiveGestures(normLandmarks);
            handleInteractiveActions(gesture);
            
            // Check for shake down if we have any pending prediction (don't wait for 1s stabilization if user is fast)
            if (pendingPrediction && isSignModeActive) {
                if (detectShakeDown(activeHandIndex, results.multiHandLandmarks[activeHandIndex])) {
                    console.log(`🫨 Shake Down confirmed! Adding: ${pendingPrediction}`);
                    addLetterToBuffer(pendingPrediction);
                    
                    // Visual success feedback
                    const centerX = results.multiHandLandmarks[activeHandIndex].reduce((s, l) => s + l.x, 0) / 21;
                    const centerY = results.multiHandLandmarks[activeHandIndex].reduce((s, l) => s + l.y, 0) / 21;
                    floatingPredictions.push({
                        text: pendingPrediction,
                        x: centerX,
                        y: centerY,
                        opacity: 1,
                        life: 1.0
                    });
                    
                    pendingPrediction = ""; // Clear pending
                    isWaitingForShake = false;
                    currentContinuousPrediction = ""; // Reset continuous tracking so we start fresh
                    els['best-match-display'].innerText = "-";
                    els['confidence-container']?.classList.add('opacity-0');
                    
                    // Extra cooldown to prevent immediate redetection
                    lastLetterTime = Date.now();
                }
            }
        }
    } else {
        els['confidence-container'].classList.add('opacity-0', 'translate-y-4');
        if (els['virtual-cursor']) els['virtual-cursor'].style.opacity = "0";
        wristHistory = []; 
        shakeHistory = [ [], [] ];
        pendingPrediction = "";
        isWaitingForShake = false;
        currentContinuousPrediction = "";
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
        const middleTip = landmarks[12];
        const ringTip = landmarks[16];
        const pinkyTip = landmarks[20];
        const thumbMCP = landmarks[2];

        // 2. Open Palm (ARMING GESTURE)
        // Check if all fingers are relatively extended and close to each other
        const distancesFromWrist = [8, 12, 16, 20].map(idx => getDist(landmarks[idx], wrist));
        const avgFingerDist = distancesFromWrist.reduce((a, b) => a + b, 0) / 4;
        const isPalmOpen = avgFingerDist > 0.4; // Fingers extended away from wrist
        
        // Check if index, middle, ring, pinky are close together (rapat)
        const spread = getDist(landmarks[8], landmarks[20]); 
        const isHandFlat = isPalmOpen && (spread < 0.3);

        if (isHandFlat) {
            return "open_palm";
        }

        // 3. Finger States (Extended vs Curled) using relative distances
        // A finger is extended if its tip is further from the wrist than its PIP joint
        const isIndexExt = getDist(indexTip, wrist) > getDist(landmarks[6], wrist);
        const isMiddleExt = getDist(middleTip, wrist) > getDist(landmarks[10], wrist);
        const isRingExt = getDist(ringTip, wrist) > getDist(landmarks[14], wrist);
        const isPinkyExt = getDist(pinkyTip, wrist) > getDist(landmarks[18], wrist);

        // Thumb is extended if its tip is significantly far from the palm center (landmark 9)
        const isThumbExt = getDist(thumbTip, landmarks[9]) > 0.35;

        // CALL SIGN (Listen): Thumb & Pinky Extended, Index/Middle/Ring Curled
        if (isThumbExt && isPinkyExt && !isIndexExt && !isMiddleExt && !isRingExt) {
            return "call_sign";
        }

        // METAL/HORN (Reset): Index & Pinky Extended, Thumb/Middle/Ring Curled
        if (isIndexExt && isPinkyExt && !isMiddleExt && !isRingExt && !isThumbExt) {
            return "metal_horn";
        }

        // FIST (Sign Mode Toggle): All fingers completely curled
        if (!isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt && !isThumbExt) {
            return "fist";
        }

        // THUMBS DOWN (Backspace): Thumb tip is physically pointing down relative to MCP
        // y is positive downwards, so tip.y > MCP.y means pointing down
        if (thumbTip.y > thumbMCP.y + 0.1 && !isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt) {
            return "thumbs_down";
        }

        // ILY / I LOVE YOU (Space): Thumb, Index, Pinky Extended. Middle, Ring Curled.
        if (isThumbExt && isIndexExt && isPinkyExt && !isMiddleExt && !isRingExt) {
            return "ily";
        }

        return "none";
    } catch (e) {
        console.error("Gesture detection error:", e);
        return "none";
    }
}

function handleInteractiveActions(gesture) {
    const cursorRing = els['virtual-cursor']?.firstElementChild;
    
    // Update visual feedback for Armed state
    if (isGestureArmed) {
        if (cursorRing) cursorRing.classList.add('animate-pulse', 'border-primary-500');
    } else {
        if (cursorRing) cursorRing.classList.remove('animate-pulse');
    }

    if (gesture === "none" || gesture === lastInteractiveGesture) {
        if (gesture === "none") lastInteractiveGesture = "none";
        return;
    }

    const now = Date.now();
    if (now - gestureDebounceTimer < GESTURE_DEBOUNCE) return;

    // ARMING LOGIC: Show open palm to arm
    if (gesture === "open_palm") {
        if (!isGestureArmed) {
            console.log("🖐️ SUCCESS: Hand Armed! Ready for command...");
            isGestureArmed = true;
            showNotification("System Armed 🖐️ (Commands Enabled)");
            
            // Visual pulse feedback
            if (cursorRing) cursorRing.classList.add('scale-150');
            setTimeout(() => cursorRing.classList.remove('scale-150'), 300);
            updateModeUI();
        }
        lastInteractiveGesture = "open_palm";
        gestureDebounceTimer = now;
        return;
    }

    // GATED COMMANDS: Only work if armed
    if (!isGestureArmed) return;

    // Trigger actions based on gesture
    let actionTriggered = false;

    if (gesture === "fist") {
        console.log("✊ Fist detected: Enabling Sign Mode...");
        isSignModeActive = true;
        showNotification("Sign Mode: ACTIVE ✍️");
        actionTriggered = true;
    } else if (gesture === "call_sign") {
        if (currentWord && currentWord !== "-") {
            console.log("🤙 Call Sign detected: Listening...");
            showNotification("Listening... 🔊");
            els['translate-btn'].click();
            triggerVBtnHaptic(els['translate-btn']);
            actionTriggered = true;
        }
    } else if (gesture === "metal_horn") {
        console.log("🤘 Metal/Horn detected: Resetting...");
        showNotification("Clearing Buffer... 🧹");
        els['clear-buffer-btn'].click();
        triggerVBtnHaptic(els['clear-buffer-btn']);
        actionTriggered = true;
    } else if (gesture === "thumbs_down") {
        console.log("👎 Thumbs Down detected: Backspace...");
        showNotification("Backspace ⌫");
        els['backspace-btn'].click();
        triggerVBtnHaptic(els['backspace-btn']);
        actionTriggered = true;
    } else if (gesture === "ily" && isSignModeActive) {
        console.log("🤟 ILY detected: Adding Space...");
        showNotification("Space ␣");
        addLetterToBuffer(" ");
        actionTriggered = true;
        
        // Add minimal visual feedback on the cursor
        const cursorRing = els['virtual-cursor']?.firstElementChild;
        if (cursorRing) {
            cursorRing.classList.add('scale-150', 'bg-primary-500/20');
            setTimeout(() => cursorRing.classList.remove('scale-150', 'bg-primary-500/20'), 300);
        }
    }

    if (actionTriggered) {
        // If we didn't just activate Sign Mode, lock it
        if (!isSignModeActive) {
            isGestureArmed = false; 
        }
        updateModeUI();
        lastInteractiveGesture = gesture;
        gestureDebounceTimer = now;
    }
}

/**
 * Detects if the hand has been still for a set duration (Dwell).
 */
function detectDwell(handIdx, landmarks) {
    if (!wristHistory[handIdx]) wristHistory[handIdx] = [];
    
    const wrist = landmarks[0];
    const now = Date.now();
    wristHistory[handIdx].push({ x: wrist.x, y: wrist.y, t: now });
    
    // Maintain a window of ~0.8 seconds (at 30fps = 24 frames)
    if (wristHistory[handIdx].length > 24) wristHistory[handIdx].shift();
    if (wristHistory[handIdx].length < 18) return false;

    // Calculate total movement in the window
    let totalDisp = 0;
    for (let i = 1; i < wristHistory[handIdx].length; i++) {
        totalDisp += Math.sqrt(
            Math.pow(wristHistory[handIdx][i].x - wristHistory[handIdx][i-1].x, 2) +
            Math.pow(wristHistory[handIdx][i].y - wristHistory[handIdx][i-1].y, 2)
        );
    }

    // Stillness threshold: total movement < 0.15m over 1s region
    // AND the last letter wasn't too recent
    const isStill = totalDisp < 0.12; 
    const timeSinceLast = now - lastLetterTime;

    return isStill && timeSinceLast > LETTER_COOLDOWN;
}

function detectBisindoModel(multiWorldLandmarks, multiHandedness, activeHandIndex) {
    if (!multiWorldLandmarks || multiWorldLandmarks.length === 0) return;
    // Gate with Sign Mode
    if (!isSignModeActive) {
        // Reset tracking vars if exiting sign mode
        currentContinuousPrediction = "";
        isWaitingForShake = false;
        pendingPrediction = "";
        return;
    }
    
    // Check if we are recently hit cooldown from a successful letter confirmation
    if (Date.now() - lastLetterTime < LETTER_COOLDOWN) return;

    // We don't need Dwell anymore, we predict constantly
    // But we prevent overlapping fetch calls
    if (isFetchingPrediction) return;

    const landmarks = multiWorldLandmarks[activeHandIndex];

    isFetchingPrediction = true;

    fetch('/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            gesture_name: "current_frame",
            landmarks: landmarks
        })
    })
    .then(res => res.json())
    .then(data => {
        isFetchingPrediction = false;
        
        let char = data.prediction;
        
        // SEMI-LOCK LOGIC:
        // Jika status sedang menunggu ayunan (isWaitingForShake) aktif, 
        // kita KUNCI prediksi yang sebelumnya stabil selama 1.5 detik ekstra
        // agar tidak tiba-tiba berubah saat tangan mulai menggoyang (shake down)
        
        if (isWaitingForShake && Date.now() - continuousPredictionStartTime < 2500) {
            // override the prediction with what was already stabilized 
            // as long as it hasn't been more than 2.5s since it first stabilized (1s wait + 1.5s lock)
            char = currentContinuousPrediction;
        } else if (isWaitingForShake && Date.now() - continuousPredictionStartTime >= 2500) {
            // Lock expired
            isWaitingForShake = false;
        }
        
        if (char && char !== "?") {
            els['confidence-container']?.classList.remove('opacity-0');
            
            // Logika Kontinu (selalu memperbarui pendingPrediction secara default)
            pendingPrediction = char; // Selalu perbarui agar Shake siap kapan saja
            
            if (char === currentContinuousPrediction) {
                // Huruf stabil (sama). Cek durasinya.
                const duration = Date.now() - continuousPredictionStartTime;
                
                if (duration > 1000 && !isWaitingForShake) {
                    // Berhasil stabil lebih dari 1 detik! Mulai KUNCI.
                    console.log(`✅ AI Stabilized on: ${char}. Showing Shake Down arrow and Locking...`);
                    isWaitingForShake = true;
                    // reset timer so the 1.5s lock countdown starts cleanly from now
                    continuousPredictionStartTime = Date.now() - 1000; 
                    
                    // Ubah UI tampilkan animasi lucide warna hijau untuk menandakan Terkunci
                    els['best-match-display'].innerHTML = `<span class="text-emerald-500">${char}</span> <i data-lucide="lock" class="inline-block w-4 h-4 text-emerald-500 mb-2"></i> <i data-lucide="arrow-down-to-line" class="inline-block w-8 h-8 text-emerald-500 animate-bounce ml-1"></i>`; 
                    if (window.lucide) {
                        window.lucide.createIcons({
                            root: els['confidence-container']
                        });
                    }
                } else if (!isWaitingForShake) {
                    // Masih loading 1 detik, tapi kita tetap tunjukkan char
                    els['best-match-display'].innerText = char;
                }
            } else {
                // Hanya bisa berganti prediksi jika TIDAK sedang terkunci
                if (!isWaitingForShake) {
                    currentContinuousPrediction = char;
                    continuousPredictionStartTime = Date.now();
                    els['best-match-display'].innerText = char;
                }
            }
            
        } else {
            // Jika hasilnya "?" tapi kita SEDANG terkunci, pertahankan locknya
            if (isWaitingForShake) return;
            
            // Prediksi hilang atau "?", reset stabilisasi
            currentContinuousPrediction = "";
            isWaitingForShake = false;
            pendingPrediction = "";
            els['best-match-display'].innerText = "-";
            
            // Sembunyikan container jika tidak ada deteksi konstan sesaat
            setTimeout(() => {
                if (!currentContinuousPrediction) {
                    els['confidence-container']?.classList.add('opacity-0');
                }
            }, 500);
        }
    })
    .catch(err => {
        isFetchingPrediction = false;
        console.error("Prediction Error:", err);
        if (!isWaitingForShake) {
            els['best-match-display'].innerText = "Err";
            currentContinuousPrediction = "";
            pendingPrediction = "";
        }
    });
}

/**
 * Detects a quick downward shake movement (Shake Down) to confirm an action.
 * Uses MediaPipe landmarks natively.
 */
function detectShakeDown(handIdx, landmarks) {
    if (!shakeHistory[handIdx]) shakeHistory[handIdx] = [];
    
    // We use Screen Space landmarks (multiHandLandmarks) for shake detection
    // because it correlates better with user's visual action.
    // y goes from 0 (top) to 1 (bottom)
    const wrist = landmarks[0];
    const now = Date.now();
    shakeHistory[handIdx].push({ y: wrist.y, t: now });
    
    // Maintain a window of ~15 frames (0.5 seconds at 30fps)
    if (shakeHistory[handIdx].length > 15) shakeHistory[handIdx].shift();
    if (shakeHistory[handIdx].length < 5) return false;

    const history = shakeHistory[handIdx];
    const firstPoint = history[0];
    const latestPoint = history[history.length - 1];
    
    // Configurable shake velocity threshold
    // Using SHAKE_SLIDER: larger value (close to 1.0) means easier to trigger (smaller threshold)
    // smaller value (close to 0.0) means harder to trigger (larger threshold)
    const dropVelocityThreshold = 0.15 - (SHAKE_SLIDER * 0.10); // range from 0.15 (hard) to 0.05 (easy)

    // Condition: Y must increase significantly (downward motion) in a short time
    const yDiff = latestPoint.y - firstPoint.y;
    const timeDiffMs = latestPoint.t - firstPoint.t;
    
    if (timeDiffMs > 0 && yDiff > dropVelocityThreshold) {
        // Clear history to prevent multiple triggers from same shake
        shakeHistory[handIdx] = [];
        return true;
    }

    return false;
}


function addLetterToBuffer(letter) {
    if (currentWord === "-" || currentWord === "") currentWord = "";
    currentWord += letter;
    updateBufferUI();
}

/**
 * Displays a temporary notification in the HUD
 * @param {string} message - Notification text
 * @param {string} type - 'info' or 'success'
 */
function showNotification(message, type = 'info') {
    const container = els['ai-notification-container'];
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `
        px-6 py-3 rounded-2xl bg-white/10 dark:bg-black/40 backdrop-blur-2xl border border-white/20 
        text-[0.65rem] font-bold text-slate-800 dark:text-white uppercase tracking-[0.2em]
        flex items-center gap-3 shadow-2xl animate-notification-in transition-all duration-500
    `;
    
    // Icon based on content
    let icon = 'info';
    if (message.includes('Armed')) icon = 'shield-check';
    if (message.includes('ACTIVE')) icon = 'zap';
    if (message.includes('Listening')) icon = 'volume-2';
    if (message.includes('Clearing')) icon = 'trash-2';
    if (message.includes('Backspace')) icon = 'delete';

    notification.innerHTML = `
        <i data-lucide="${icon}" class="w-3.5 h-3.5 text-primary-400"></i>
        <span>${message}</span>
    `;

    container.appendChild(notification);
    
    // Refresh lucide icons
    if (window.lucide) {
        window.lucide.createIcons({
            attrs: { class: 'w-3.5 h-3.5' },
            nameAttr: 'data-lucide'
        });
    }

    // Auto remove
    setTimeout(() => {
        notification.classList.add('opacity-0', '-translate-y-4');
        setTimeout(() => notification.remove(), 500);
    }, 2500);
}

/**
 * Updates the Word Buffer UI with dynamic font scaling and auto-scroll
 * @param {boolean} updateText - Whether to update the innerText (false for manual edits)
 * @param {boolean} setCaretAtEnd - Whether to force the caret to the end
 */
function updateBufferUI(updateText = true, setCaretAtEnd = true) {
    const buffer = els['word-buffer'];
    const container = els['word-buffer-container'];
    
    if (updateText) {
        buffer.innerText = currentWord || "-";
        if (setCaretAtEnd && currentWord) placeCaretAtEnd(buffer);
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

function placeCaretAtEnd(el) {
    el.focus();
    if (typeof window.getSelection != "undefined" && typeof document.createRange != "undefined") {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

/**
 * Fetches threshold configuration from the backend
 */
async function fetchConfig() {
    try {
        const response = await fetch('/config');
        const data = await response.json();
        
        // Update Sliders
        if (els['match-threshold-input']) {
            els['match-threshold-input'].value = data.match;
            els['match-threshold-val'].innerText = parseFloat(data.match).toFixed(2);
            MATCH_SLIDER = data.match;
            MATCH_THRESHOLD = 1.5 - (MATCH_SLIDER * 1.0);
        }
        
        if (els['shake-threshold-input']) {
            els['shake-threshold-input'].value = data.shake;
            els['shake-threshold-val'].innerText = parseFloat(data.shake).toFixed(2);
            SHAKE_SLIDER = data.shake;
        }

        if (els['k-neighbors-input'] && data.k_neighbors !== undefined) {
            els['k-neighbors-input'].value = data.k_neighbors;
            els['k-neighbors-val'].innerText = data.k_neighbors;
            K_NEIGHBORS = data.k_neighbors;
        }
        
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
                confidence: 0.5, // Obsolete but kept for retrocompatibility with config.ini
                k_neighbors: K_NEIGHBORS
            })
        });
    } catch (e) {
        console.error("Failed to save config:", e);
    }
}

async function sendToBackend() {
    if (!currentWord || currentWord === "-") return;
    
    // We only trigger audio generation, no "Translating" status needed
    try {
        const response = await fetch('/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gesture_name: currentWord }),
        });
        
        const data = await response.json();
        
        if (data.translated_text) {
            // Add to History silently
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            translationHistory.unshift({
                text: data.translated_text,
                audio: data.audio_base64,
                timestamp: timestamp
            });
            updateHistoryUI();
        }
        
        lastAudioBase64 = data.audio_base64;
        if (data.audio_base64) playAudio(data.audio_base64);
        
    } catch (error) {
        console.error("TTS Error:", error);
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
        // Browser modern memblokir akses kemera (navigator.mediaDevices) jika tidak menggunakan HTTPS atau localhost
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert("Akses kamera diblokir oleh browser karena masalah keamanan.\n\nPastikan Anda mengakses web ini menggunakan HTTPS (SSL) atau melalui localhost.");
            throw new Error("Kamera membutuhkan HTTPS (Secure Context)");
        }
        
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
        if (err.name === 'NotAllowedError') {
             alert("Izin kamera ditolak. Mohon izinkan akses kamera di pengaturan browser Anda.");
        }
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
