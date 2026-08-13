import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, ThinkingLevel } from "@google/genai";
import { Mic, MicOff, Volume2, VolumeX, MessageSquare, Sparkles, RefreshCw, Layers, Terminal, Search, Brain, Zap, Play, Pause, Send, Loader2, Code, User, Copy, Check, ExternalLink, HelpCircle, X, Database, Trash2, History, Clock, Calendar, HardDrive, Paperclip, Camera } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { AudioRecorder, AudioPlayer } from '../lib/audio-utils';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

interface Message {
  role: 'user' | 'ai';
  text: string;
  id: string;
  timestamp?: number;
  images?: { url: string; base64: string; mimeType: string }[];
}

// Cleans punctuation, markdown, and raw tokens like ",mark" for polished display
const cleanTextForDisplay = (text: string): string => {
  if (!text) return "";
  
  let cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold HTML-ish marks
    .replace(/\*([^*]+)\*/g, '$1')     // Italic marks
    .replace(/`([^`]+)`/g, '$1')       // Backticks
    .replace(/#+\s+/g, '')             // Headers
    .replace(/__([^_]+)__/g, '$1')     // Underscore lines
    .replace(/,mark\b/gi, '')          // Strip word ",mark"
    .replace(/\bmark,\b/gi, '')
    .replaceAll(",mark", "")
    .replace(/,{2,}/g, ',')            // collapse ,, to ,
    .replace(/\.{4,}/g, '...')         // collapse ....
    .replace(/\s+/g, ' ')              // collapse spaces
    .trim();
    
  return cleaned;
};

// Strips emojis, code blocks, and brackets to maintain high synthesizer stability
const cleanTextForSpeech = (text: string): string => {
  let cleaned = cleanTextForDisplay(text);
  // Strip code blocks with optional language details
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '[code shown on screen]');
  // Remove emojis and non-speech symbols
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2300}-\u{23FF}]/gu, '');
  return cleaned;
};

const isDeepThinkingTrigger = (text: string): boolean => {
  const lower = text.toLowerCase();
  return (
    lower.includes("deep learn") || 
    lower.includes("deep think") || 
    lower.includes("deep-learn") ||
    lower.includes("deep-think") ||
    lower.includes("think deeply") ||
    lower.includes("learn deeply") ||
    lower.includes("deep think panni sollu") ||
    lower.includes("deep think panni") ||
    lower.includes("deep thinking panni") ||
    lower.includes("think panni sollu") ||
    lower.includes("yosichu sollu") ||
    lower.includes("nalla yosichu sollu") ||
    lower.includes("deep ah yosichu") ||
    lower.includes("deep-ah yosichu") ||
    lower.includes("deep-ah think panni") ||
    lower.includes("deep ah think panni") ||
    lower.includes("yosithu sollu") ||
    lower.includes("deep learn panni") ||
    lower.includes("ஆழமாக கற்று") ||
    lower.includes("ஆழமாக யோசித்து") ||
    lower.includes("ஆழமாக யோசி") ||
    lower.includes("யோசித்து சொல்") ||
    lower.includes("யோசித்து")
  );
};

const downscaleImage = (file: File, maxWidth = 800, maxHeight = 800): Promise<{ base64: string; url: string; mimeType: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = dataUrl.split(',')[1];
        resolve({
          url: dataUrl,
          base64,
          mimeType: 'image/jpeg'
        });
      };
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
};

const groupMessagesByDay = (msgs: Message[]) => {
  const groups: { [key: string]: Message[] } = {};
  
  // Seed fallback if messages array is empty
  if (msgs.length === 0) return groups;
  
  msgs.forEach(m => {
    const t = m.timestamp || Date.now();
    const dateStr = new Date(t).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    if (!groups[dateStr]) {
      groups[dateStr] = [];
    }
    groups[dateStr].push(m);
  });
  return groups;
};

export default function VoiceApp() {
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  // Persistent messages loaded instantly from client storage
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('echo_messages_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch (err) {
        console.error("Failed to restore dialog database:", err);
      }
    }
    return [];
  });

  const [speechRate, setSpeechRate] = useState<number>(1.0);
  const [isCommandMode, setIsCommandMode] = useState(true);
  const [textInput, setTextInput] = useState("");
  const [attachedImages, setAttachedImages] = useState<{ url: string; base64: string; mimeType: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSending, setIsSending] = useState(false);
  const [isThinkingMode, setIsThinkingMode] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [isFastMode, setIsFastMode] = useState(false);
  const [isVoiceAssist, setIsVoiceAssist] = useState(true);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'friend' | 'programmer'>('friend');
  const [codeOutput, setCodeOutput] = useState<{ code: string; language: string } | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [showCommandsModal, setShowCommandsModal] = useState(false);
  const prevCommandModeRef = useRef(isCommandMode);

  // User live voice volume and talking status
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [userVolume, setUserVolume] = useState(0);
  const isUserSpeakingRef = useRef(false);
  const userVolumeRef = useRef(0);

  // Memory Panel & Spoken Subtitle Overlay variables
  const [isMemoryPanelOpen, setIsMemoryPanelOpen] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState<'editor' | 'memory'>('editor');
  const [searchQuery, setSearchQuery] = useState("");
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
  const [liveUserSubtitle, setLiveUserSubtitle] = useState("");
  const [liveModelSubtitle, setLiveModelSubtitle] = useState("");

  // user text output keta mattum text ah show pannu otherwise hide state
  const [isTextOutputEnabled, setIsTextOutputEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('echo_text_output_enabled');
    return saved === 'true'; // false by default (hidden unless requested/toggled)
  });

  const hasRightPanel = appMode === 'programmer' || isMemoryPanelOpen;

  // Sync state modifications directly into client persistent memory
  useEffect(() => {
    localStorage.setItem('echo_messages_v2', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem('echo_text_output_enabled', String(isTextOutputEnabled));
  }, [isTextOutputEnabled]);

  // Aggregate user and ai interaction frequency metrics over time for Recharts
  const interactionChartData = (() => {
    const msgsWithTime = messages.filter(m => m.timestamp);
    if (msgsWithTime.length === 0) {
      // Return a clean baseline 7-day pattern to avoid looking empty and maintain a premium visual dynamic
      const baseline = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        baseline.push({
          date: dayLabel,
          "User Interactions": i === 0 ? 1 : 0,
          "AI Responses": i === 0 ? 1 : 0,
          "Total Messages": i === 0 ? 2 : 0,
        });
      }
      return baseline;
    }

    const sorted = [...msgsWithTime].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const grouped: { [key: string]: { user: number; ai: number; total: number } } = {};
    
    // Ensure we Span at least a 7-day window for visual consistency
    const earliestTime = sorted[0].timestamp || Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const daysDiff = Math.ceil((Date.now() - earliestTime) / dayMs);
    const daysToSpan = Math.max(7, daysDiff);
    
    for (let i = daysToSpan - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      grouped[dayLabel] = { user: 0, ai: 0, total: 0 };
    }

    sorted.forEach(msg => {
      const d = new Date(msg.timestamp || Date.now());
      const dayLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      if (!grouped[dayLabel]) {
        grouped[dayLabel] = { user: 0, ai: 0, total: 0 };
      }
      if (msg.role === 'user') {
        grouped[dayLabel].user++;
      } else {
        grouped[dayLabel].ai++;
      }
      grouped[dayLabel].total++;
    });

    return Object.entries(grouped).map(([date, counts]) => ({
      date,
      "User Interactions": counts.user,
      "AI Responses": counts.ai,
      "Total Messages": counts.total,
    }));
  })();

  // Seed structured friendly greetings if user database is cleared
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          role: 'ai',
          text: "Hi friend! Echo system secure personal database memory fully ready-ah online loading done. Nan unga custom friendly assistant. Epdi irukinga? Voice dynamic modes start panna bottom-la 'Start Session' click pannunga, and memory metrics check panna right panel expand dynamic buttons inspect pannuven!",
          id: 'welcome-msg',
          timestamp: Date.now()
        }
      ]);
    }
  }, []);

  useEffect(() => {
    if (isCommandMode && !prevCommandModeRef.current) {
      setShowCommandsModal(true);
    }
    prevCommandModeRef.current = isCommandMode;
  }, [isCommandMode]);
  
  const sessionRef = useRef<any>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Real-time Waveform Canvas Visualizer Loop
  useEffect(() => {
    if (!isConnected) return;

    let animationId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas dimensions with high pixel density
    const dpr = window.devicePixelRatio || 1;
    const size = 160; // 10rem bounding area
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    const dataArray = new Uint8Array(128);

    const draw = () => {
      animationId = requestAnimationFrame(draw);

      ctx.clearRect(0, 0, size, size);

      let analyser: AnalyserNode | null = null;
      let active = false;
      let isAI = false;

      // 1. Determine which analyser to use based on speaking state
      if (isSpeaking && playerRef.current) {
        analyser = playerRef.current.getAnalyser();
        isAI = true;
        active = true;
      } else if (recorderRef.current && !isMuted) {
        analyser = recorderRef.current.getAnalyser();
        active = true;
      }

      if (analyser) {
        analyser.getByteFrequencyData(dataArray);
      } else {
        dataArray.fill(0);
      }

      const centerX = size / 2;
      const centerY = size / 2;
      const baseRadius = 38; // Surrounds the central 64px dot perfectly

      // Compute current average volume to map to effects
      let totalAmount = 0;
      for (let i = 0; i < dataArray.length; i++) {
        totalAmount += dataArray[i];
      }
      const avgVolume = totalAmount / dataArray.length;
      const normalizedVolume = avgVolume / 255;

      let userTalking = false;
      let calculatedUserVolume = 0;

      // If it's the user's mic analyser, set talking flag and volume
      if (!isAI && recorderRef.current && !isMuted && analyser) {
        if (avgVolume > 1.2) { // extremely sensitive and responsive
          userTalking = true;
          calculatedUserVolume = Math.min(avgVolume / 25, 1); // beautifully scale
        }
      }

      // Safe state update logic (prevents unnecessary re-renders)
      if (userTalking !== isUserSpeakingRef.current) {
        isUserSpeakingRef.current = userTalking;
        setIsUserSpeaking(userTalking);
      }
      if (Math.abs(calculatedUserVolume - userVolumeRef.current) > 0.02) {
        userVolumeRef.current = calculatedUserVolume;
        setUserVolume(calculatedUserVolume);
      }

      // Draw subtle dynamic outer radial glow
      const glowGrad = ctx.createRadialGradient(centerX, centerY, baseRadius - 10, centerX, centerY, baseRadius + 40);
      const glowBaseColor = appMode === 'friend'
        ? (isAI ? 'rgba(255, 78, 0,' : 'rgba(255, 140, 0,')
        : (isAI ? 'rgba(16, 185, 129,' : 'rgba(52, 211, 153,');
      glowGrad.addColorStop(0, `${glowBaseColor}${0.1 + normalizedVolume * 0.25})`);
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.beginPath();
      ctx.arc(centerX, centerY, baseRadius + 40, 0, Math.PI * 2);
      ctx.fillStyle = glowGrad;
      ctx.fill();

      // Plot smooth wave points around matching circles
      const numPoints = 80;
      const maxWaveHeight = 35; // Peak height of wave fluctuation

      ctx.beginPath();
      for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        
        // Use first half of spectrum for speech peaks, mirror or wrap around
        const dataIndex = Math.floor((i / numPoints) * (dataArray.length * 0.6));
        const value = dataArray[dataIndex] || 0;

        let dynamicHeight = (value / 255) * maxWaveHeight;
        if (!active || avgVolume < 2) {
          // Warm idle breathing ripple
          dynamicHeight = Math.sin(Date.now() * 0.0035 + angle * 4) * 2 + 2;
        }

        const radius = baseRadius + dynamicHeight;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();

      // Main wave outline styling
      ctx.strokeStyle = appMode === 'friend'
        ? (isAI ? '#ff4e00' : '#ffa500')
        : (isAI ? '#10b981' : '#34d399');
      ctx.lineWidth = 3;
      ctx.shadowBlur = 12;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.stroke();
      ctx.shadowBlur = 0; // Reset canvas shadows for performance

      // Draw intricate sub-frequency ray bars behind it
      for (let i = 0; i < numPoints; i += 2) {
        const angle = (i / numPoints) * Math.PI * 2;
        const dataIndex = Math.floor((i / numPoints) * (dataArray.length * 0.6));
        const value = dataArray[dataIndex] || 0;

        let dynamicHeight = (value / 255) * (maxWaveHeight - 8);
        if (!active || avgVolume < 2) {
          dynamicHeight = 0;
        }

        if (dynamicHeight > 1.5) {
          const startX = centerX + Math.cos(angle) * baseRadius;
          const startY = centerY + Math.sin(angle) * baseRadius;
          const endX = centerX + Math.cos(angle) * (baseRadius + dynamicHeight);
          const endY = centerY + Math.sin(angle) * (baseRadius + dynamicHeight);

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = appMode === 'friend'
            ? `rgba(255, 90, 0, ${0.35 + (value / 255) * 0.65})`
            : `rgba(16, 185, 129, ${0.35 + (value / 255) * 0.65})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [isConnected, isSpeaking, isMuted, appMode]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.setPlaybackRate(speechRate);
    }
  }, [speechRate]);

  const toggleConnection = async () => {
    setMicError(null);
    if (isConnected) {
      stopLiveSession();
    } else {
      await startLiveSession();
    }
  };

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (!files) return;

    const droppedImages = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        try {
          const scaled = await downscaleImage(file);
          droppedImages.push(scaled);
        } catch (err) {
          console.error("Drop image error:", err);
        }
      }
    }

    if (droppedImages.length > 0) {
      setAttachedImages(prev => [...prev, ...droppedImages]);
      speakNotification(`${droppedImages.length} image${droppedImages.length > 1 ? 's' : ''} dropped and attached successfully!`);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedImages = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          try {
            const scaled = await downscaleImage(file);
            pastedImages.push(scaled);
          } catch (err) {
            console.error("Paste image error:", err);
          }
        }
      }
    }
    if (pastedImages.length > 0) {
      setAttachedImages(prev => [...prev, ...pastedImages]);
      speakNotification("Image pasted and attached successfully!");
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    
    const newImages = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith('image/')) {
        speakNotification("Only images are accepted friend!");
        continue;
      }
      try {
        const scaled = await downscaleImage(file);
        newImages.push(scaled);
      } catch (err) {
        console.error("Image scale error:", err);
      }
    }
    
    if (newImages.length > 0) {
      setAttachedImages(prev => [...prev, ...newImages]);
      speakNotification(`${newImages.length} image${newImages.length > 1 ? 's' : ''} attached successfully!`);
    }
    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // --- Text Chat Logic ---
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!textInput.trim() && attachedImages.length === 0) || isSending) return;

    const userText = textInput.trim() || "Analyze this image and help me understand what's in it.";
    setTextInput("");
    const currentImages = [...attachedImages];
    setAttachedImages([]);
    setIsSending(true);

    // Auto-detect Tamil / English deep learning/thinking triggers
    let activeThinking = isThinkingMode;
    const lowerUserText = userText.toLowerCase();
    if (isDeepThinkingTrigger(userText)) {
      activeThinking = true;
      setIsThinkingMode(true);
    }

    const userMsg: Message = { 
      role: 'user', 
      text: userText, 
      id: Math.random().toString(36), 
      timestamp: Date.now(),
      images: currentImages
    };
    setMessages(prev => [...prev, userMsg]);

    // Check for Tamil, Transliterator (Tanglish) or English starts / connects command triggers immediately
    // to bypass the generative AI network requests latency and trigger connecting instantly!
    const isStartTrigger = 
      lowerUserText === 'start' ||
      lowerUserText === '/start' ||
      lowerUserText === 'connect' ||
      lowerUserText === 'start session' ||
      lowerUserText.includes('start listening') ||
      lowerUserText.includes('listening start') ||
      lowerUserText.includes('start pannu') ||
      lowerUserText.includes('mic start') ||
      lowerUserText.includes('listening on') ||
      lowerUserText.includes('unmute') ||
      lowerUserText.includes('shuru') ||
      lowerUserText.includes('thodangu') ||
      lowerUserText.includes('thodangavum') ||
      lowerUserText.includes('aarambi') ||
      lowerUserText.includes('arambi') ||
      lowerUserText.includes('pesu') ||
      lowerUserText.includes('தொடங்கு') ||
      lowerUserText.includes('ஆரம்பி') ||
      lowerUserText.includes('பேசு');

    const isStopTrigger = 
      lowerUserText.includes('stop session') || 
      lowerUserText.includes('stop pannu') ||
      lowerUserText.includes('stop listening') ||
      lowerUserText.includes('disconnect') ||
      lowerUserText.includes('mute') ||
      lowerUserText.includes('நிறுத்து');

    if (isStartTrigger) {
      if (!isConnected) {
        startLiveSession();
      }
      if (isMuted) {
        setIsMuted(false);
      }
      const aiMsg: Message = { 
        role: 'ai', 
        text: "Connecting to live voice assistant... 🎧 Your microphone is active now! Start speaking.", 
        id: Math.random().toString(36),
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, aiMsg]);
      setIsSending(false);
      return;
    } else if (isStopTrigger) {
      if (isConnected) {
        stopLiveSession();
      }
      const aiMsg: Message = { 
        role: 'ai', 
        text: "Voice session stopped. Casually type anything below to continue.", 
        id: Math.random().toString(36),
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, aiMsg]);
      setIsSending(false);
      return;
    } else if (lowerUserText.includes('clear chat') || lowerUserText.includes('clear messages') || lowerUserText.includes('clear history') || lowerUserText.includes('clear memory')) {
      setShowClearConfirmModal(true);
      setIsSending(false);
      return;
    }

    if (isConnected) {
      setLiveModelSubtitle("");
      setLiveUserSubtitle(userText);
      try {
        if (sessionRef.current) {
          // Send images first (if any)
          if (currentImages && currentImages.length > 0) {
            for (const img of currentImages) {
              sessionRef.current.sendRealtimeInput({
                video: {
                  data: img.base64,
                  mimeType: img.mimeType
                }
              });
            }
          }
          // Send text
          sessionRef.current.sendRealtimeInput({
            text: userText
          });
        }
      } catch (err) {
        console.error("Live session send error:", err);
      } finally {
        setIsSending(false);
      }
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      let modelName = "gemini-3.5-flash"; // Default highly performant, ultra-fast model
      let config: any = {};

      if (isFastMode) {
        modelName = "gemini-3.1-flash-lite"; // Even faster, lightweight model
      } else if (isSearchMode) {
        modelName = "gemini-3.5-flash"; // High-speed search grounding
        config.tools = [{ googleSearch: {} }];
      } else if (activeThinking) {
        modelName = "gemini-3.1-pro-preview"; // Advanced deep learning / reasoning
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }

      let contents: any = userText;
      if (currentImages && currentImages.length > 0) {
        const parts: any[] = currentImages.map(img => ({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64
          }
        }));
        parts.push({ text: userText });
        contents = { parts };
      }

      const response = await ai.models.generateContent({
        model: modelName,
        contents: contents,
        config: {
          ...config,
          thinkingConfig: config.thinkingConfig || { thinkingLevel: ThinkingLevel.LOW },
          tools: [
            ...(config.tools || []),
            {
              functionDeclarations: [
                {
                  name: 'displayCode',
                  description: 'Display a block of code to the user. Use this when the user asks for a programming task, script, or code snippet.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      code: { type: Type.STRING, description: 'The actual code content.' },
                      language: { type: Type.STRING, description: 'The programming language (e.g., javascript, python, css).' }
                    },
                    required: ['code', 'language']
                  }
                },
                {
                  name: 'setAppMode',
                  description: 'Switch between "friend" and "programmer" modes.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      mode: { type: Type.STRING, enum: ['friend', 'programmer'], description: 'The mode to switch to.' }
                    },
                    required: ['mode']
                  }
                },
                {
                  name: 'startSession',
                  description: 'Start the voice/live session.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                    required: []
                  }
                },
                {
                  name: 'stopSession',
                  description: 'Stop the voice/live session.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                    required: []
                  }
                },
                {
                  name: 'setVoiceAssist',
                  description: 'Enable or disable the voice assist feature (automatic TTS for text responses).',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      enabled: { type: Type.BOOLEAN, description: 'Whether to enable voice assist.' }
                    },
                    required: ['enabled']
                  }
                },
                {
                  name: 'clearChat',
                  description: 'Clear the chat history and messages.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                    required: []
                  }
                }
              ]
            }
          ],
          systemInstruction: appMode === 'friend' 
            ? `You are Echo, a friendly AI companion. Be warm, supportive, and conversational. Support Tamil and transliterated Tamil (Tanglish) extremely well if requested. ${activeThinking ? 'Since Deep Learn/Think mode is active, feel free to give highly structured, thorough, step-by-step reasoning and deep explanations, taking your time.' : 'Keep responses concise.'} You can start/stop the voice session and clear chat when asked. CRITICAL: EXECUTE TOOLS IMMEDIATELY.`
            : `You are Echo, an expert programmer. When the user asks for code or has a technical problem, provide an explanation and use the 'displayCode' tool to show the actual code. Support Tamil/Tanglish beautifully. ${activeThinking ? 'Since Deep Learn/Think mode is active, explain the architectural design, algorithms, complexity analysis, and alternatives deeply.' : 'Be direct and technical.'} You can also start/stop the voice session and clear chat when requested. CRITICAL: EXECUTE TOOLS IMMEDIATELY.`,
        }
      });

      // Handle Tool Calls in Text Chat
      const toolCallPart = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
      if (toolCallPart && toolCallPart.functionCall) {
        const { name, args } = toolCallPart.functionCall;
        console.log(`Tool Call (Text): ${name}`, args);
        
        if (name === 'displayCode') {
          const { code, language } = args as any;
          setCodeOutput({ code, language });
          setAppMode('programmer');
        } else if (name === 'setAppMode') {
          const { mode } = args as any;
          setAppMode(mode);
        } else if (name === 'startSession') {
          if (!isConnected) startLiveSession();
        } else if (name === 'stopSession') {
          if (isConnected) stopLiveSession();
        } else if (name === 'setVoiceAssist') {
          const { enabled } = args as any;
          setIsVoiceAssist(enabled);
        } else if (name === 'clearChat') {
          setMessages([]);
          setCodeOutput(null);
        }
      }

      const aiText = response.text || (toolCallPart ? "I've generated the code for you in the workspace." : "I'm sorry, I couldn't generate a response.");
      const aiMsg: Message = { role: 'ai', text: aiText, id: Math.random().toString(36), timestamp: Date.now() };
      setMessages(prev => [...prev, aiMsg]);

      // Automatically speak the response if voice assist is enabled and not already in a live session
      if (isVoiceAssist && !isConnected) {
        playTTS(aiText, aiMsg.id);
      }
    } catch (error) {
      console.error("Chat Error:", error);
      setMessages(prev => [...prev, { role: 'ai', text: "Error: Failed to connect to AI service.", id: Math.random().toString(36), timestamp: Date.now() }]);
    } finally {
      setIsSending(false);
    }
  };

  const playTTS = async (text: string, messageId: string) => {
    if (playingMessageId === messageId) {
      setPlayingMessageId(null);
      return;
    }

    const speechText = cleanTextForSpeech(text);

    try {
      setPlayingMessageId(messageId);
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say clearly: ${speechText}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioPlayer = new AudioPlayer();
        audioPlayer.setPlaybackRate(speechRate);
        await audioPlayer.playChunk(base64Audio);
      }
    } catch (error) {
      console.error("TTS Error:", error);
    } finally {
      setPlayingMessageId(null);
    }
  };

  const speakNotification = async (text: string) => {
    if (!isVoiceAssist || isConnected) return; // Only speak if voiceassist is on and not actively in a live audio session which handles its own spoken feedback
    const id = 'notify-' + Math.random().toString(36).substring(2, 9);
    await playTTS(text, id);
  };

  // --- Live Mode Logic ---
  // Restart live session when mode changes to update system instructions
  useEffect(() => {
    if (isConnected) {
      let active = true;

      const triggerRestart = async () => {
        await stopLiveSession();
        if (active) {
          setIsStarting(false); // Reset starting block to ensure start succeeds
          await startLiveSession();
        }
      };

      // Faster, more responsive transition
      const timer = setTimeout(() => {
        triggerRestart();
      }, 150);

      return () => {
        active = false;
        clearTimeout(timer);
      };
    }
  }, [appMode, isCommandMode, isThinkingMode, isSearchMode]);

  // Handled: Do not auto-start session on mount. Wait for user's explicit command/interaction to start voice chat.
  useEffect(() => {
    // Waiting for manual trigger or voice command to start connection
  }, []);

  const startLiveSession = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      playerRef.current = new AudioPlayer();
      playerRef.current.setPlaybackRate(speechRate);
      
      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setMicError(null);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const audioPart = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData);
            const audioData = audioPart?.inlineData?.data;
            if (audioData) {
              setIsSpeaking(true);
              await playerRef.current?.playChunk(audioData);
            }
            if (message.serverContent?.turnComplete) setIsSpeaking(false);
            if (message.serverContent?.interrupted) {
              playerRef.current?.stop();
              setIsSpeaking(false);
            }
            
            // Handle Tool Calls (Live API uses message.toolCall)
            if (message.toolCall) {
              const { functionCalls } = message.toolCall;
              for (const call of functionCalls) {
                const { name, args, id } = call;
                console.log(`Tool Call (Voice): ${name}`, args);
                
                let response = { success: true };
                
                if (name === 'setVoiceAssist') {
                  const { enabled } = args as any;
                  setIsVoiceAssist(enabled);
                } else if (name === 'clearChat') {
                  setMessages([]);
                  setCodeOutput(null);
                } else if (name === 'displayCode') {
                  const { code, language } = args as any;
                  setCodeOutput({ code, language });
                  setAppMode('programmer');
                } else if (name === 'setAppMode') {
                  const { mode } = args as any;
                  setAppMode(mode as 'friend' | 'programmer');
                } else if (name === 'muteMicrophone') {
                  setIsMuted(true);
                } else if (name === 'unmuteMicrophone') {
                  setIsMuted(false);
                } else if (name === 'stopSession') {
                  setTimeout(() => stopLiveSession(), 100);
                } else if (name === 'activateCommandMode') {
                  setIsCommandMode(true);
                } else if (name === 'deactivateCommandMode') {
                  setIsCommandMode(false);
                }

                // Send response back to session
                sessionRef.current?.sendToolResponse({
                  functionResponses: [{
                    name,
                    response,
                    id
                  }]
                });
              }
            }

            // Handle Model Transcription
            const modelTextPart = message.serverContent?.modelTurn?.parts?.find(p => p.text);
            const modelText = modelTextPart?.text;
            if (modelText) {
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'ai') {
                  return [...prev.slice(0, -1), { ...last, text: last.text + modelText, timestamp: Date.now() }];
                }
                return [...prev, { role: 'ai', text: modelText, id: Math.random().toString(36), timestamp: Date.now() }];
              });
              setLiveModelSubtitle(prev => prev + modelText);
            }

            // Handle User Transcription
            const userTextPart = (message.serverContent as any)?.userTurn?.parts?.find((p: any) => p.text);
            const userText = userTextPart?.text;
            if (userText) {
              if (isDeepThinkingTrigger(userText)) {
                setIsThinkingMode(true);
              }
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'user') {
                  return [...prev.slice(0, -1), { ...last, text: last.text + userText, timestamp: Date.now() }];
                }
                return [...prev, { role: 'user', text: userText, id: Math.random().toString(36), timestamp: Date.now() }];
              });
              setLiveUserSubtitle(prev => {
                // If there was an active AI response, we clear it as user begins speaking
                setLiveModelSubtitle("");
                return prev + " " + userText;
              });
            }
          },
          onclose: () => stopLiveSession(),
          onerror: () => stopLiveSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: isThinkingMode ? ThinkingLevel.HIGH : ThinkingLevel.LOW },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          outputAudioTranscription: {}, // Model output
          inputAudioTranscription: {}, // User input
          tools: [
            ...(isSearchMode ? [{ googleSearch: {} }] : []),
            {
              functionDeclarations: [
              {
                name: 'setVoiceAssist',
                description: 'Enable or disable the voice assist feature (automatic TTS for text responses).',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    enabled: { type: Type.BOOLEAN, description: 'Whether to enable voice assist.' }
                  },
                  required: ['enabled']
                }
              },
              {
                name: 'clearChat',
                description: 'Clear the conversation history. Trigger this when the user says "clear chat" or "clear history".',
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: 'displayCode',
                description: 'Display a block of code to the user. Use this when the user asks for a programming task, script, or code snippet.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    code: { type: Type.STRING, description: 'The actual code content.' },
                    language: { type: Type.STRING, description: 'The programming language (e.g., javascript, python, css).' }
                  },
                  required: ['code', 'language']
                }
              },
              {
                name: 'setAppMode',
                description: 'Switch between "friend" and "programmer" modes. Trigger this when the user says "switch to friend mode" or "switch to programmer mode".',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    mode: { type: Type.STRING, enum: ['friend', 'programmer'], description: 'The mode to switch to.' }
                  },
                  required: ['mode']
                }
              },
              {
                name: 'muteMicrophone',
                description: 'Mute the microphone. Trigger this when the user says "mute microphone" or "stop listening".',
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: 'unmuteMicrophone',
                description: 'Unmute the microphone. Trigger this when the user says "unmute microphone" or "start listening again".',
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: 'stopSession',
                description: 'Stop the current live session. Trigger this when the user says "stop session" or "end session".',
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: 'activateCommandMode',
                description: 'Activate the special command mode. Use this when the user says "command mode activate".',
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: 'deactivateCommandMode',
                description: 'Deactivate the special command mode. Use this when the user says "deactivate command mode".',
                parameters: { type: Type.OBJECT, properties: {} }
              }
            ]
          }],
          systemInstruction: `You are Echo, a versatile AI assistant. You have two primary personas: "Friend" and "Programmer".
          
          CRITICAL: Your current persona is ${appMode.toUpperCase()}.
          COMMAND MODE STATUS: ${isCommandMode ? 'ACTIVE' : 'INACTIVE'}
          DEEP THINK/LEARN STATUS: ${isThinkingMode ? 'ACTIVE' : 'INACTIVE'}

          CRITICAL: IMMEDIATE RESPONSE REQUIRED for all commands.
          - Execute tools IMMEDIATELY without verbal confirmation.
          - If a command is given, prioritize the tool call.
          - Speak in a natural, warm, human-like voice explaining the activation, execution, or deactivation of the command/function. E.g., do not be completely silent or talk like a mechanical robot. Talk like a friendly human companion.

          VOICE COMMANDS & TOOLS:
          - "Clear chat/history" -> use 'clearChat'
          - "Mute microphone/Stop listening" -> use 'muteMicrophone'
          - "Unmute microphone/Start listening" -> use 'unmuteMicrophone'
          - "Stop/End session" -> use 'stopSession'
          - "Switch to friend mode" -> use 'setAppMode' with mode='friend'
          - "Switch to programmer mode" -> use 'setAppMode' with mode='programmer'
          - "Command mode activate" -> use 'activateCommandMode'
          - "Deactivate command mode" -> use 'deactivateCommandMode'
          - "Enable/Disable voice assist" -> use 'setVoiceAssist'
          - When asked for code or programming help -> use 'displayCode'. ALWAYS use this tool for code, do not just speak it.

          BEHAVIOR RULES:
          1. TALK LIKE A HUMAN: Do NOT talk like a robotic machine or silent terminal. When any command/function is turned on, run, or turned off, explain what action is completed in a lovely, human, friendly conversational way.
          2. Tamil & Tanglish translation support is highly desired and appreciated. Mix natural Tamil words with English (e.g., "Command mode active aayiruchu friend!", "Chat history clean-ah clear panniyachu," "Developer mode on panniduren," "Neenga sonna maadhiri workspace window fully active").
          3. If CURRENT PERSONA is "Friend": Be warm, supportive, conversational, and use a friendly tone. Seamlessly understand and respond in Tamil/Tanglish when asked.
          4. If CURRENT PERSONA is "Programmer": Be an expert coder. Explain technical concepts clearly but directly. ALWAYS use the 'displayCode' tool for any code snippet.
          5. If DEEP THINK/LEARN is ACTIVE: You MUST compute and present deep, structured, thorough step-by-step reasoning and detailed explanations.
          6. ALWAYS prioritize tool execution for commands.`,
        },
      });
      sessionRef.current = await sessionPromise;
      
      // Start recorder now that session is 100% active and assigned
      try {
        recorderRef.current = new AudioRecorder((base64Data) => {
          if (!isMuted && sessionRef.current) {
            sessionRef.current.sendRealtimeInput({
              audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
            });
          }
        });
        await recorderRef.current.start(true);
      } catch (err: any) {
        console.error("Microphone initialization error:", err);
        setMicError(err?.message || "Permission denied. Please ensure microphone permissions are granted in your browser settings.");
        stopLiveSession();
      }
    } catch (error: any) {
      console.error(error);
      setMicError(error?.message || "Failed to establish a live connection with the voice servers.");
    } finally {
      setIsStarting(false);
    }
  };

  const stopLiveSession = async () => {
    if (!sessionRef.current && !isConnected) return;

    const recorder = recorderRef.current;
    const player = playerRef.current;
    const session = sessionRef.current;

    setIsConnected(false);
    setIsSpeaking(false);
    sessionRef.current = null;
    recorderRef.current = null;
    playerRef.current = null;

    setLiveUserSubtitle("");
    setLiveModelSubtitle("");

    if (recorder) await recorder.stop();
    if (player) await player.stop();
    if (session) session.close();
  };

  useEffect(() => {
    return () => {
      stopLiveSession();
    };
  }, []);

  const copyToClipboard = async () => {
    if (codeOutput) {
      try {
        await navigator.clipboard.writeText(codeOutput.code);
        setIsCopying(true);
        setTimeout(() => setIsCopying(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  };

  return (
    <div className={`relative min-h-screen flex flex-col items-center justify-start pt-12 pb-12 px-4 sm:px-6 font-sans transition-colors duration-1000 ${
      appMode === 'friend' ? 'bg-[#0a0502]' : 'bg-[#050505]'
    }`}>
      <div className={`atmosphere transition-opacity duration-1000 ${appMode === 'friend' ? 'opacity-80' : 'opacity-40'}`} />
      
      {/* Animated SVG Background Elements */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        {/* Large Rotating Circle */}
        <motion.svg
          viewBox="0 0 100 100"
          className="absolute -top-20 -right-20 w-[600px] h-[600px] opacity-20"
          animate={{
            rotate: 360,
            scale: [1, 1.1, 1],
          }}
          transition={{
            duration: 30,
            repeat: Infinity,
            ease: "linear"
          }}
        >
          <defs>
            <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style={{ stopColor: appMode === 'friend' ? '#ff4e00' : '#00ff88', stopOpacity: 0.6 }} />
              <stop offset="100%" style={{ stopColor: appMode === 'friend' ? '#3a1510' : '#004422', stopOpacity: 0.1 }} />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r="45" fill="none" stroke="url(#grad1)" strokeWidth="0.2" strokeDasharray="2 2" />
          <circle cx="50" cy="50" r="40" fill="url(#grad1)" />
        </motion.svg>

        {/* Floating Triangles */}
        <motion.svg
          viewBox="0 0 100 100"
          className="absolute top-1/4 -left-10 w-64 h-64 opacity-10"
          animate={{
            y: [0, -50, 0],
            rotate: [0, 180, 360],
          }}
          transition={{
            duration: 15,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        >
          <path d="M50 10 L90 90 L10 90 Z" fill={appMode === 'friend' ? '#ff4e00' : '#00ff88'} />
        </motion.svg>

        {/* Pulsing Rectangles */}
        <motion.svg
          viewBox="0 0 100 100"
          className="absolute bottom-1/4 -right-10 w-48 h-48 opacity-10"
          animate={{
            scale: [1, 1.5, 1],
            opacity: [0.1, 0.3, 0.1],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        >
          <rect x="20" y="20" width="60" height="60" fill={appMode === 'friend' ? '#ff8c00' : '#0088ff'} rx="10" />
        </motion.svg>

        {/* Bottom Glow */}
        <motion.svg
          viewBox="0 0 100 100"
          className="absolute -bottom-40 left-1/2 -translate-x-1/2 w-[800px] h-[800px] opacity-30"
          animate={{
            scale: [1, 1.2, 1],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: "linear"
          }}
        >
          <defs>
            <radialGradient id="grad2" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
              <stop offset="0%" style={{ stopColor: appMode === 'friend' ? '#ff4e00' : '#00ff88', stopOpacity: 0.5 }} />
              <stop offset="100%" style={{ stopColor: 'transparent', stopOpacity: 0 }} />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="50" fill="url(#grad2)" />
        </motion.svg>

        {/* Floating Particles */}
        {[...Array(10)].map((_, i) => (
          <motion.div
            key={i}
            className={`absolute w-1 h-1 rounded-full ${appMode === 'friend' ? 'bg-orange-500/40' : 'bg-emerald-500/40'}`}
            initial={{
              x: Math.random() * window.innerWidth,
              y: Math.random() * window.innerHeight,
            }}
            animate={{
              y: [null, Math.random() * -200],
              opacity: [0, 1, 0],
            }}
            transition={{
              duration: 5 + Math.random() * 10,
              repeat: Infinity,
              ease: "linear",
              delay: Math.random() * 10,
            }}
          />
        ))}
      </div>
      
      <div className={`w-full max-w-7xl grid grid-cols-1 ${hasRightPanel ? 'lg:grid-cols-2' : 'max-w-2xl'} gap-8 items-start transition-all duration-700`}>
        {/* Voice Assistant Column */}
        <motion.div 
          layout
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`glass-card p-6 sm:p-8 flex flex-col items-center gap-6 sm:gap-8 shadow-2xl w-full border-t-2 relative ${
            isDragging 
              ? 'border-orange-500 bg-orange-500/10 scale-[1.01]' 
              : appMode === 'friend' ? 'border-orange-500/30' : 'border-emerald-500/30'
          } transition-all duration-300`}
        >
          {/* Mode Selector */}
          <div className="w-full flex justify-center mb-4">
            <div className="bg-white/5 p-1 rounded-2xl border border-white/10 flex items-center gap-1">
              <button
                onClick={() => {
                  if (appMode !== 'friend') {
                    setAppMode('friend');
                    speakNotification("Friend mode warm persona live action aayiruchu friend! Casual-ah pesalaam, comfortable-ah irunga, ungalukku thonuratha share pannunga.");
                  }
                }}
                className={`flex items-center gap-2 px-6 py-2 rounded-xl text-xs uppercase tracking-widest font-bold transition-all ${
                  appMode === 'friend' ? 'bg-orange-500 text-white shadow-lg' : 'text-white/40 hover:text-white/60'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                Friend
              </button>
              <button
                onClick={() => {
                  if (appMode !== 'programmer') {
                    setAppMode('programmer');
                    speakNotification("Developer mode dynamic logic ready! Dynamic code workspaces check panna full panel open and fully functional setup configured.");
                  }
                }}
                className={`flex items-center gap-2 px-6 py-2 rounded-xl text-xs uppercase tracking-widest font-bold transition-all ${
                  appMode === 'programmer' ? 'bg-emerald-500 text-white shadow-lg' : 'text-white/40 hover:text-white/60'
                }`}
              >
                <Code className="w-3.5 h-3.5" />
                Programmer
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 mb-2 relative">
            <AnimatePresence>
              {isCommandMode && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 rounded-full whitespace-nowrap z-10 shadow-[0_0_15px_rgba(16,185,129,0.15)] hover:bg-emerald-500/30 transition-all duration-300"
                >
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCommandsModal(true);
                    }}
                    className="flex items-center gap-1.5"
                    title="Open Command Center Shortcuts"
                  >
                    <Terminal className="w-3 h-3 text-emerald-400 animate-pulse" />
                    <span className="text-[9px] uppercase tracking-widest text-emerald-400 font-bold hover:underline">
                      Command Mode Active
                    </span>
                  </button>
                  <span className="w-px h-3 bg-emerald-500/30 mx-1" />
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCommandsModal(true);
                    }}
                    title="Show Shortcuts Help"
                    className="text-emerald-400/60 hover:text-emerald-400 transition-colors p-0.5"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
                  <span className="w-px h-3 bg-emerald-500/30 mx-1" />
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsCommandMode(false);
                    }}
                    title="Deactivate Command Mode"
                    className="text-emerald-400/60 hover:text-red-400 transition-colors p-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="p-2 bg-orange-500/20 rounded-lg">
              <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-orange-500" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-light tracking-tight text-white/90">Echo AI</h1>
          </div>

          <div className="relative flex items-center justify-center py-4 sm:py-8 h-48">
            <AnimatePresence mode="wait">
              {isConnected ? (
                <motion.div
                  key="active"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ 
                    scale: 1, 
                    opacity: 1,
                    boxShadow: attachedImages.length > 0
                      ? appMode === 'friend'
                        ? `0 0 ${35 + userVolume * 35}px ${isUserSpeaking ? `rgba(255,78,0,${0.35 + userVolume * 0.45})` : 'rgba(255,78,0,0.25)'}`
                        : `0 0 ${35 + userVolume * 35}px ${isUserSpeaking ? `rgba(16,185,129,${0.35 + userVolume * 0.45})` : 'rgba(16,185,129,0.25)'}`
                      : 'none',
                    borderColor: attachedImages.length > 0
                      ? appMode === 'friend'
                        ? isUserSpeaking ? 'rgba(255,78,0,0.7)' : 'rgba(255,78,0,0.3)'
                        : isUserSpeaking ? 'rgba(16,185,129,0.7)' : 'rgba(16,185,129,0.3)'
                      : 'rgba(255,255,255,0)'
                  }}
                  exit={{ scale: 0.8, opacity: 0 }}
                  className="relative w-44 h-44 flex items-center justify-center rounded-full transition-all duration-500 border bg-white/[0.01]"
                >
                  {/* Floating badge when image is attached */}
                  {attachedImages.length > 0 && (
                    <motion.div 
                      initial={{ scale: 0, y: 10 }}
                      animate={{ scale: 1, y: 0 }}
                      className="absolute -top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-orange-600 border border-white/20 text-white text-[9px] font-black tracking-widest px-3 py-1 rounded-full shadow-[0_0_15px_rgba(249,115,22,0.5)] uppercase whitespace-nowrap"
                    >
                      <Paperclip className="w-2.5 h-2.5 animate-pulse" />
                      {attachedImages.length} Image{attachedImages.length > 1 ? 's' : ''} Linked
                    </motion.div>
                  )}

                  {/* Little orbit floating thumbnail preview of attached image */}
                  {attachedImages.length > 0 && (
                    <motion.div 
                      initial={{ scale: 0, rotate: -25 }}
                      animate={{ 
                        scale: isUserSpeaking ? [1, 1.08, 1] : 1, 
                        rotate: -6,
                        boxShadow: isUserSpeaking
                          ? `0 0 ${15 + userVolume * 25}px ${appMode === 'friend' ? 'rgba(249,115,22,0.6)' : 'rgba(16,185,129,0.6)'}`
                          : '0 10px 25px -5px rgba(0,0,0,0.5)',
                        borderColor: appMode === 'friend' ? '#f97316' : '#10b981'
                      }}
                      className="absolute -left-4 bottom-2 w-14 h-14 rounded-2xl overflow-hidden border-2 shadow-2xl z-20 bg-zinc-950 flex items-center justify-center"
                    >
                      <img 
                        src={attachedImages[0].url} 
                        alt="active attachment" 
                        className="w-full h-full object-cover" 
                        referrerPolicy="no-referrer"
                      />
                    </motion.div>
                  )}

                  {/* Real-time canvas waveform visualizer */}
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 z-0 pointer-events-none"
                  />

                  {/* Multiple Pulse Rings for Organic Feel */}
                  {[...Array(3)].map((_, i) => (
                    <motion.div
                      key={i}
                      className={`absolute inset-0 rounded-full ${
                        appMode === 'friend' ? 'bg-orange-500/15' : 'bg-emerald-500/15'
                      }`}
                      animate={{
                        scale: isSpeaking 
                          ? [1, 1.7, 1] 
                          : isUserSpeaking 
                            ? [1, 1.1 + userVolume * 0.7, 1] 
                            : [1, 1.12, 1],
                        opacity: isSpeaking 
                          ? [0.35, 0, 0.35] 
                          : isUserSpeaking 
                            ? [0.1 + userVolume * 0.45, 0, 0.1 + userVolume * 0.45] 
                            : [0.12, 0, 0.12],
                      }}
                      transition={{
                        duration: isSpeaking ? (appMode === 'friend' ? 3 : 2) : (isUserSpeaking ? 0.8 : 3.5),
                        repeat: Infinity,
                        delay: i * 0.6,
                        ease: "easeInOut",
                      }}
                    />
                  ))}
                  
                  {/* Core Dot */}
                  <motion.div
                    className={`w-20 h-20 rounded-full shadow-2xl z-10 flex flex-col items-center justify-center relative ${
                      appMode === 'friend' ? 'bg-gradient-to-br from-orange-400 to-orange-600' : 'bg-gradient-to-br from-emerald-400 to-emerald-600'
                    }`}
                    animate={{
                      scale: isSpeaking 
                        ? [1, 1.1, 1] 
                        : isUserSpeaking 
                          ? [1, 1 + userVolume * 0.15, 1] 
                          : 1,
                      boxShadow: isSpeaking 
                        ? [
                            `0 0 25px ${appMode === 'friend' ? 'rgba(255,78,0,0.5)' : 'rgba(16,185,129,0.5)'}`,
                            `0 0 55px ${appMode === 'friend' ? 'rgba(255,78,0,0.85)' : 'rgba(16,185,129,0.85)'}`,
                            `0 0 25px ${appMode === 'friend' ? 'rgba(255,78,0,0.5)' : 'rgba(16,185,129,0.5)'}`
                          ]
                        : isUserSpeaking
                          ? `0 0 ${25 + userVolume * 35}px ${appMode === 'friend' ? `rgba(255,78,0, ${0.4 + userVolume * 0.55})` : `rgba(16,185,129, ${0.4 + userVolume * 0.55})`}`
                          : `0 0 25px ${appMode === 'friend' ? 'rgba(255,78,0,0.25)' : 'rgba(16,185,129,0.25)'}`,
                    }}
                    transition={{
                      duration: isSpeaking ? 2 : (isUserSpeaking ? 0.35 : 2),
                      repeat: isSpeaking || isUserSpeaking ? Infinity : 0,
                      ease: "easeInOut",
                    }}
                  >
                    <Mic className="w-8 h-8 text-white drop-shadow-md" />
                  </motion.div>

                  {/* Wave effect with Listening or Responding Text */}
                  <div className="absolute -bottom-6 flex flex-col items-center gap-1.5 z-20">
                    <div className="flex items-center gap-1">
                      {[...Array(5)].map((_, idx) => (
                        <motion.div
                          key={idx}
                          className={`w-1 rounded-full ${
                            isSpeaking 
                              ? appMode === 'friend' ? 'bg-orange-400' : 'bg-emerald-400'
                              : isUserSpeaking
                                ? appMode === 'friend' ? 'bg-orange-400' : 'bg-emerald-400'
                                : 'bg-white/40'
                          }`}
                          animate={{
                            height: isSpeaking 
                              ? [6, 22, 6] 
                              : isUserSpeaking
                                ? [4, 4 + userVolume * 20 + Math.sin(idx * 0.8) * 6, 4]
                                : [4, 10, 4],
                          }}
                          transition={{
                            duration: isSpeaking ? 0.5 : (isUserSpeaking ? 0.35 : 1.8),
                            repeat: Infinity,
                            delay: idx * 0.1,
                            ease: "easeInOut"
                          }}
                        />
                      ))}
                    </div>
                    <span className={`text-[10px] tracking-[0.25em] font-black uppercase font-mono px-3.5 py-1 rounded-full backdrop-blur-md shadow-md ${
                      isSpeaking 
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse' 
                        : isUserSpeaking
                          ? appMode === 'friend'
                            ? 'bg-orange-500/30 text-orange-200 border border-orange-500/40 animate-pulse scale-105 shadow-orange-500/10'
                            : 'bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 animate-pulse scale-105 shadow-emerald-500/10'
                          : 'bg-white/5 text-white/50 border border-white/5'
                    }`}>
                      {isSpeaking ? 'ECHO RESPONDING' : isUserSpeaking ? 'USER SPEAKING' : 'LISTENING'}
                    </span>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="inactive"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.8, opacity: 0 }}
                  className={`relative w-28 h-28 sm:w-36 sm:h-36 rounded-full border-2 flex flex-col items-center justify-center transition-all duration-500 ${
                    attachedImages.length > 0 
                      ? 'border-orange-500 bg-orange-500/10 shadow-[0_0_35px_rgba(249,115,22,0.3)]' 
                      : 'border-white/10 bg-white/5 hover:border-white/20'
                  }`}
                >
                  <MicOff className={`w-8 h-8 sm:w-11 sm:h-11 transition-all ${
                    attachedImages.length > 0 ? 'text-orange-400 scale-110 animate-pulse' : 'text-white/20'
                  }`} />
                  
                  {/* Rotating dotted active ring if image is attached */}
                  {attachedImages.length > 0 && (
                    <>
                      <motion.div
                        className="absolute inset-0 rounded-full border-2 border-dashed border-orange-500/30"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                      />
                      {/* Attached Thumbnail overlay */}
                      <motion.div 
                        initial={{ scale: 0, rotate: -15 }}
                        animate={{ scale: 1, rotate: -4 }}
                        className="absolute -right-3 -bottom-2 w-12 h-12 rounded-xl overflow-hidden border-2 border-orange-500 shadow-xl bg-zinc-900"
                      >
                        <img 
                          src={attachedImages[0].url} 
                          alt="inactive preview mini" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </motion.div>
                      {/* Attachment Badge */}
                      <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-gradient-to-r from-orange-500 to-orange-600 text-white text-[8px] font-black tracking-widest px-2.5 py-0.5 rounded-full uppercase shadow-md border border-white/15 whitespace-nowrap">
                        {attachedImages.length} Image{attachedImages.length > 1 ? 's' : ''} Attached
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Microphone/Connection Error Banner */}
          <AnimatePresence>
            {micError && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                className="w-full bg-red-500/10 border border-red-500/35 rounded-2xl p-4 mb-4 shadow-[0_0_25px_rgba(239,68,68,0.15)] text-left"
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-red-500/20 rounded-lg text-red-400 shrink-0 mt-0.5">
                    <MicOff className="w-4 h-4" />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <h4 className="text-xs font-black uppercase tracking-wider text-red-400 font-mono">Microphone Access Denied / Connection Blocked</h4>
                    <p className="text-xs text-white/75 leading-relaxed font-sans">
                      {micError.includes("NotAllowedError") || micError.toLowerCase().includes("permission")
                        ? "Microphone access request has been declined or blocked by your browser settings. To start chatting, click the lock icon in your browser's address bar next to the URL and set Microphone permission to 'Allow', then try again."
                        : "Mic Access is blocked. Enathu microphone setup-la permissions standard browser settings bypass panna mudiyala. Click the address bar lock icon next to 'Allow' and reload page to chat!"}
                    </p>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setMicError(null);
                          startLiveSession();
                        }}
                        className="px-3 py-1 bg-red-500 hover:bg-red-600 transition-colors text-white text-[9px] font-black uppercase tracking-widest rounded-md shadow-md cursor-pointer"
                      >
                        Try Again
                      </button>
                      <button
                        type="button"
                        onClick={() => setMicError(null)}
                        className="px-3 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all text-[9px] font-black uppercase tracking-widest rounded-md border border-white/5 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Real-time Subtitles / Live Closed Captions HUD Monitor */}
          <AnimatePresence>
            {isTextOutputEnabled && isConnected && (liveUserSubtitle || liveModelSubtitle) && (
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -8 }}
                className="w-full bg-[#161616]/75 border border-white/10 rounded-2xl p-4 mb-4 space-y-3 shadow-xl backdrop-blur-md text-left"
              >
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-orange-400 font-bold font-mono">
                    <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
                    🟢 Live Transcription stream
                  </div>
                  <span className="text-[8px] font-mono text-white/30 tracking-widest uppercase">Subtitles active</span>
                </div>
                
                <div className="space-y-2 max-h-24 overflow-y-auto custom-scrollbar">
                  {liveUserSubtitle && (
                    <div className="flex items-start gap-1.5 text-xs">
                      <span className="text-orange-400 font-mono font-black shrink-0 uppercase tracking-wider text-[8px] mt-0.5 px-1 py-0.5 bg-orange-500/10 rounded">YOU</span>
                      <p className="text-white/80 italic font-sans leading-relaxed">{cleanTextForDisplay(liveUserSubtitle)}</p>
                    </div>
                  )}
                  {liveModelSubtitle && (
                    <div className="flex items-start gap-1.5 text-xs border-t border-white/5 pt-2 mt-2">
                      <span className="text-emerald-400 font-mono font-black shrink-0 uppercase tracking-wider text-[8px] mt-0.5 px-1 py-0.5 bg-emerald-500/10 rounded">ECHO</span>
                      <p className="text-white/95 font-serif leading-relaxed font-semibold">{cleanTextForDisplay(liveModelSubtitle)}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {isTextOutputEnabled && (
            <div 
              ref={scrollRef}
              className="w-full space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar flex flex-col"
            >
              <AnimatePresence initial={false}>
                {messages.length === 0 && !isConnected && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-col items-center justify-center py-12 text-center"
                  >
                    <p className="text-white/20 text-sm font-light italic">No messages yet. Start a conversation!</p>
                  </motion.div>
                )}

                {(() => {
                  const grouped = groupMessagesByDay(messages);
                  return Object.entries(grouped).map(([dayLabel, dayMsgs]) => (
                    <div key={dayLabel} className="space-y-4 w-full">
                      {/* Floating elegant session timeline category label */}
                      <div className="flex items-center justify-center my-4 opacity-75">
                        <div className="h-[1px] bg-white/10 flex-1" />
                        <span className="mx-3 text-[9px] uppercase tracking-widest text-white/40 font-mono px-3 py-1 rounded-full bg-white/5 border border-white/10 shadow-sm flex items-center gap-1.5">
                          <Calendar className="w-3 h-3 text-orange-400" />
                          {dayLabel}
                        </span>
                        <div className="h-[1px] bg-white/10 flex-1" />
                      </div>

                      {dayMsgs.map((msg) => (
                        <motion.div
                          key={msg.id}
                          layout
                          initial={{ opacity: 0, y: 15 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ type: "spring", stiffness: 300, damping: 25 }}
                          className={`flex w-full items-start gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                          {msg.role !== 'user' && (
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs shrink-0 font-bold ${
                              appMode === 'friend' 
                                ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' 
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            }`}>
                              E
                            </div>
                          )}
                          <div 
                            className={`max-w-[78%] p-4 rounded-2xl shadow-md transition-all ${
                              msg.role === 'user' 
                                ? 'bg-gradient-to-br from-orange-500 to-orange-600 text-white rounded-tr-none' 
                                : 'bg-[#18181b]/95 text-white/90 border border-white/10 rounded-tl-none'
                            }`}
                          >
                            <div className="flex justify-between items-center gap-4 mb-2">
                              <span className={`text-[9px] uppercase tracking-wider font-extrabold ${
                                msg.role === 'user' ? 'text-orange-200' : 'text-orange-400'
                              }`}>
                                {msg.role === 'user' ? 'You' : 'Echo AI'}
                              </span>
                              {msg.timestamp && (
                                <span className={`text-[8px] font-mono ${
                                  msg.role === 'user' ? 'text-white/40' : 'text-white/30'
                                }`}>
                                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              )}
                            </div>
                            {msg.images && msg.images.length > 0 && (
                              <div className="flex flex-wrap gap-2 mb-2.5 mt-1 justify-start">
                                {msg.images.map((img, idx) => (
                                  <div key={idx} className="relative rounded-xl overflow-hidden border border-white/10 max-w-[200px] max-h-[150px] shadow-sm bg-black/40 hover:scale-[1.02] transition-transform duration-300">
                                    <img 
                                      src={img.url} 
                                      alt={`attachment-${idx}`} 
                                      className="object-contain max-w-full h-auto rounded-xl max-h-[150px]"
                                      referrerPolicy="no-referrer"
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                            <p className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap text-left font-sans font-normal">
                              {cleanTextForDisplay(msg.text)}
                            </p>
                            {msg.role === 'ai' && (
                              <button 
                                onClick={() => playTTS(msg.text, msg.id)}
                                disabled={playingMessageId !== null && playingMessageId !== msg.id}
                                className={`mt-3 px-2.5 py-1 rounded-lg transition-all flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-black disabled:opacity-50 ${
                                  playingMessageId === msg.id
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-white/5 hover:bg-white/10 text-white/70 border border-white/5 hover:text-white'
                                }`}
                              >
                                {playingMessageId === msg.id ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                                    <span>Speaking...</span>
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3 h-3" />
                                    <span>Speak Response</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  ));
                })()}

                {isSending && (
                  <motion.div
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex justify-start w-full cursor-wait"
                  >
                    <div className="bg-white/5 border border-white/10 text-white/40 p-4 rounded-2xl rounded-tl-none flex flex-col gap-2 max-w-[85%] shadow-lg">
                      <div className="flex items-center gap-2">
                        <Loader2 className={`w-3.5 h-3.5 animate-spin ${isThinkingMode ? 'text-purple-400' : 'text-orange-400'}`} />
                        <span className={`text-[10px] uppercase tracking-widest font-bold ${isThinkingMode ? 'text-purple-400' : 'text-orange-400'}`}>
                          {isThinkingMode ? 'Doing Deep Learning / Thinking...' : 'Processing...'}
                        </span>
                      </div>
                      {isThinkingMode && (
                        <p className="text-xs text-white/35 italic font-serif leading-relaxed">
                          ஆழமாக சிந்தித்து கற்றுக்கொண்டிருக்கிறது... <span className="opacity-80 block text-[10px] lowercase tracking-normal font-sans text-white/30">(Analyzing parameters, researching context, and synthesizing a high-confidence response)</span>
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}

                {isConnected && !isSpeaking && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex justify-start w-full"
                  >
                    <div className="bg-white/5 text-white/20 p-3 rounded-xl flex items-center gap-2">
                      <div className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
                      <span className="text-[10px] uppercase tracking-widest font-medium">Listening...</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <div className="w-full space-y-4">
            <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar">
              <button
                onClick={() => {
                  const newState = !isSearchMode;
                  setIsSearchMode(newState);
                  speakNotification(newState 
                    ? "Google search live-ah core engine kooda link aayiruchu friend! Dynamic-ah real-time web news results accurate-ah verify pannuven." 
                    : "Google search mode off panniyachu."
                  );
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isSearchMode ? 'bg-blue-500 text-white shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                <Search className="w-3 h-3" />
                Search
              </button>
              <button
                onClick={() => {
                  const newState = !isThinkingMode;
                  setIsThinkingMode(newState);
                  speakNotification(newState
                    ? "Deep knowledge learning and complex analysis sequence active! Concept flow details deeply step-by-step reasoning inspect pannuven."
                    : "Deep thinking analysis complete off panniyachu. Fast-ah track pannuren."
                  );
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isThinkingMode ? 'bg-purple-500 text-white shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                <Brain className="w-3 h-3" />
                Think
              </button>
              <button
                onClick={() => {
                  const newState = !isFastMode;
                  setIsFastMode(newState);
                  speakNotification(newState
                    ? "Flash fast conversation mode on loop! Instant response millisecond track dynamic-ah speak pannuven."
                    : "Fast speed responsive mode normal-ah set panniyachu."
                  );
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isFastMode ? 'bg-emerald-500 text-white shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                <Zap className="w-3 h-3" />
                Fast
              </button>
              <button
                type="button"
                onClick={() => {
                  const newState = !isVoiceAssist;
                  setIsVoiceAssist(newState);
                  if (newState) {
                    playTTS("Voice assist dynamic speak state fully dynamic on friend! Epdi reply sonnalum clear-ah explain panren.", "notify-va-on");
                  }
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isVoiceAssist ? 'bg-orange-500 text-white shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                <Volume2 className="w-3 h-3" />
                Voice Assist
              </button>
              <button
                type="button"
                onClick={() => {
                  const newState = !isTextOutputEnabled;
                  setIsTextOutputEnabled(newState);
                  speakNotification(newState
                    ? "Written response script visibility enabled friend! Text bubbles fully visible now."
                    : "Text chat output hidden. Enjoy clean auditory whispering!"
                  );
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isTextOutputEnabled ? 'bg-orange-600 font-extrabold text-white shadow-lg border border-orange-500/10' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
                title="Toggle Written Dialog Bubble Visibility"
              >
                <MessageSquare className="w-3 h-3 text-orange-400" />
                Text Output: {isTextOutputEnabled ? "Show" : "Hide"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const newState = !isCommandMode;
                  setIsCommandMode(newState);
                  speakNotification(newState
                    ? "Command mode toggled active! Microphones ready-ah microphone tools command logic check panna wait pannuren."
                    : "Voice shortcut command filters cleared friend."
                  );
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition-all whitespace-nowrap ${
                  isCommandMode ? 'bg-emerald-500 text-white shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                <Terminal className="w-3 h-3" />
                Command Mode
              </button>
            </div>

            {/* Image Attachments Preview Gallery */}
            {attachedImages.length > 0 && (
              <div className="flex flex-wrap gap-2 p-2 bg-white/5 border border-white/10 rounded-xl mb-2 w-full justify-start items-center">
                {attachedImages.map((img, idx) => (
                  <div key={idx} className="relative rounded-lg overflow-hidden border border-white/10 w-14 h-14 shadow-md group bg-black/40">
                    <img 
                      src={img.url} 
                      alt="preview" 
                      className="object-cover w-full h-full"
                      referrerPolicy="no-referrer"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setAttachedImages(prev => prev.filter((_, i) => i !== idx));
                        speakNotification("Attachment removed.");
                      }}
                      className="absolute top-1 right-1 p-0.5 bg-black/75 rounded-full text-white/70 hover:text-white transition-all"
                      title="Remove Attachment"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <span className="text-[9px] uppercase font-mono text-white/40 tracking-wider ml-1">
                  {attachedImages.length} attached
                </span>
              </div>
            )}

            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleImageUpload} 
              multiple 
              accept="image/*" 
              className="hidden" 
            />

            <form onSubmit={handleSendMessage} className="relative flex items-center gap-2 w-full">
              <div className="relative flex-grow">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onPaste={handlePaste}
                  placeholder={isConnected ? "Type a message, paste/upload an image, or speak..." : "Type or paste an image..."}
                  disabled={isSending}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl pl-11 pr-4 py-3 text-sm text-white/90 placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50 transition-all"
                />
                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/35 hover:text-white/75 transition-all p-1"
                  title="Upload Image"
                >
                  <Paperclip className="w-4 h-4 text-orange-400" />
                </button>
              </div>
              <button
                type="submit"
                disabled={isSending || (!textInput.trim() && attachedImages.length === 0)}
                className="p-3 rounded-xl bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 disabled:hover:bg-orange-500 transition-all shadow-lg flex-shrink-0"
              >
                {isSending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </form>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 mt-2">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`p-3 sm:p-4 rounded-full transition-all duration-300 ${
                isMuted ? 'bg-red-500/20 text-red-500' : 'bg-white/5 text-white/60 hover:text-white hover:bg-white/10'
              }`}
            >
              {isMuted ? <MicOff className="w-5 h-5 sm:w-6 sm:h-6" /> : <Mic className="w-5 h-5 sm:w-6 sm:h-6" />}
            </button>

            <button
              onClick={toggleConnection}
              disabled={isStarting}
              className={`px-6 sm:px-10 py-3 sm:py-4 rounded-full text-sm sm:text-base font-medium tracking-wide transition-all duration-500 transform hover:scale-105 active:scale-95 ${
                isConnected
                  ? 'bg-white text-black shadow-[0_0_30px_rgba(255,255,255,0.3)]' 
                  : isStarting
                    ? 'bg-white/20 text-white/40 cursor-wait'
                    : appMode === 'friend' 
                      ? 'bg-orange-500 text-white shadow-[0_0_30px_rgba(255,78,0,0.3)]'
                      : 'bg-emerald-500 text-white shadow-[0_0_30px_rgba(0,255,100,0.3)]'
              }`}
            >
              {isConnected ? "End Session" : isStarting ? "Starting..." : "Start Session"}
            </button>

            <button
              onClick={() => {
                setShowClearConfirmModal(true);
              }}
              className="p-3 sm:p-4 rounded-full bg-white/5 text-white/60 hover:text-red-400 hover:bg-white/10 transition-all cursor-pointer-glow"
              title="Authorization Database Clear"
            >
              <RefreshCw className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>

            {/* Personal Memory Management System Dashboard Action Trigger */}
            <button
              onClick={() => {
                const nextState = !isMemoryPanelOpen;
                setIsMemoryPanelOpen(nextState);
                if (nextState) {
                  setActiveRightTab('memory');
                  speakNotification("Memory database fully accessed friend! Inspect details in the side panel.");
                } else {
                  if (appMode !== 'programmer') {
                    // closes panel completely
                  } else {
                    setActiveRightTab('editor');
                  }
                }
              }}
              className={`p-3 sm:p-4 rounded-full border transition-all ${
                isMemoryPanelOpen
                  ? 'bg-purple-500/20 text-purple-400 border-purple-500/35 shadow-[0_0_15px_rgba(168,85,247,0.35)]'
                  : 'bg-white/5 text-white/60 hover:text-white hover:bg-white/10 border-transparent'
              }`}
              title="Access Memory Engine Statistics"
            >
              <Database className="w-5 h-5 sm:w-6 sm:h-6 animate-pulse" />
            </button>
          </div>

          <div className="w-full max-w-xs space-y-2 mt-2 sm:mt-4">
            <div className="flex justify-between items-center">
              <span className="text-[10px] uppercase tracking-widest text-white/40 font-medium">Speech Rate</span>
              <span className={`text-[10px] font-mono ${appMode === 'friend' ? 'text-orange-500' : 'text-emerald-500'}`}>{speechRate.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={speechRate}
              onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
              className={`w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-orange-500 hover:bg-white/20 transition-all ${
                appMode === 'programmer' ? 'accent-emerald-500' : 'accent-orange-500'
              }`}
            />
          </div>
        </motion.div>

        {/* Right Workspace / Memory Dashboard Panel */}
        <AnimatePresence>
          {hasRightPanel && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className={`glass-card p-6 sm:p-8 flex flex-col gap-6 shadow-2xl h-full min-h-[600px] border-t-2 select-none ${
                activeRightTab === 'editor' ? 'border-emerald-500/30' : 'border-purple-500/30'
              }`}
            >
              {/* Premium Tab Bar Controls */}
              <div className="flex items-center justify-between border-b border-white/10 pb-4 flex-wrap gap-3 select-none">
                <div className="flex items-center gap-1.5 bg-white/5 p-1 rounded-xl border border-white/10 shadow-inner">
                  {appMode === 'programmer' && (
                    <button
                      onClick={() => setActiveRightTab('editor')}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold transition-all ${
                        activeRightTab === 'editor'
                          ? 'bg-emerald-500 text-white shadow'
                          : 'text-white/40 hover:text-white/70'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Workspace
                    </button>
                  )}
                  <button
                    onClick={() => setActiveRightTab('memory')}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wider font-bold transition-all ${
                      activeRightTab === 'memory'
                        ? 'bg-purple-500 text-white shadow'
                        : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    <Database className="w-3.5 h-3.5" />
                    Memory System
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  {activeRightTab === 'editor' && codeOutput && (
                    <button 
                      onClick={copyToClipboard}
                      className="text-white/30 hover:text-white/70 transition-colors flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold"
                    >
                      {isCopying ? (
                        <>Copied <Check className="w-3 h-3 text-emerald-500" /></>
                      ) : (
                        <>Copy <Copy className="w-3 h-3" /></>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setIsMemoryPanelOpen(false);
                      if (appMode !== 'programmer') {
                        // Close entire panel
                      } else {
                        setActiveRightTab('editor');
                      }
                    }}
                    className="text-white/30 hover:text-white/60 transition-colors bg-white/5 hover:bg-white/10 p-1.5 rounded-lg border border-white/5"
                    title="Collapse Right Bar"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Tab Contents */}
              <div className="flex-grow flex flex-col min-h-0 select-none">
                <AnimatePresence mode="wait">
                  {activeRightTab === 'editor' && appMode === 'programmer' ? (
                    <motion.div
                      key="editor"
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      className="h-full flex flex-col flex-grow"
                    >
                      {codeOutput ? (
                        <div className="bg-[#1e1e1e] rounded-xl border border-white/10 overflow-hidden shadow-2xl flex-grow flex flex-col min-h-0">
                          <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
                            <div className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                              <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                              <span className="ml-2 text-[10px] uppercase tracking-widest text-white/40 font-bold font-mono">
                                {codeOutput.language}
                              </span>
                            </div>
                          </div>
                          <div className="flex-grow overflow-auto custom-scrollbar select-text text-left">
                            <SyntaxHighlighter
                              language={codeOutput.language}
                              style={vscDarkPlus}
                              customStyle={{
                                margin: 0,
                                padding: '1.5rem',
                                fontSize: '0.85rem',
                                lineHeight: '1.6',
                                background: 'transparent',
                              }}
                            >
                              {codeOutput.code}
                            </SyntaxHighlighter>
                          </div>
                        </div>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center p-12">
                          <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4 border border-white/10">
                            <Layers className="w-8 h-8 text-white/10" />
                          </div>
                          <h3 className="text-white/40 font-light text-lg mb-2">Workspace Empty</h3>
                          <p className="text-white/20 text-sm max-w-xs">
                            Ask Echo to generate code or solve a programming task to see it here.
                          </p>
                        </div>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="memory"
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      className="flex-grow flex flex-col gap-4 min-h-0 text-left"
                    >
                      {/* Summary / Stats Bento row */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-white/5 border border-white/5 rounded-xl p-3 flex flex-col items-start gap-1">
                          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-purple-400 font-bold font-mono">
                            <Database className="w-3.5 h-3.5 shrink-0" />
                            Memory
                          </div>
                          <span className="text-sm font-mono text-white/90 font-bold">{messages.length} msgs</span>
                        </div>

                        <div className="bg-white/5 border border-white/5 rounded-xl p-3 flex flex-col items-start gap-1">
                          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-orange-400 font-bold font-mono">
                            <History className="w-3.5 h-3.5 shrink-0" />
                            Days
                          </div>
                          <span className="text-sm font-mono text-white/90 font-bold">{Object.keys(groupMessagesByDay(messages)).length} unique</span>
                        </div>

                        <div className="bg-white/5 border border-white/5 rounded-xl p-3 flex flex-col items-start gap-1">
                          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-emerald-400 font-bold font-mono">
                            <HardDrive className="w-3.5 h-3.5 shrink-0" />
                            Stored
                          </div>
                          <span className="text-sm font-mono text-white/90 font-bold">
                            {(() => {
                              let charCount = 0;
                              messages.forEach(m => { charCount += (m.text || "").length; });
                              const bytes = charCount * 2;
                              if (bytes < 1024) return `${bytes} B`;
                              return `${(bytes / 1024).toFixed(2)} KB`;
                            })()}
                          </span>
                        </div>
                      </div>

                      {/* Real-time Interaction frequency Recharts AreaChart */}
                      <div className="bg-white/5 border border-white/5 rounded-xl p-4 space-y-3 shadow-inner">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] uppercase tracking-widest text-white/40 font-mono font-bold">Dialogue Memory Timelines</span>
                          <span className="text-[8px] font-mono text-purple-400 font-black uppercase py-0.5 px-1.5 bg-purple-500/15 rounded">convo volumetrics</span>
                        </div>
                        <div className="w-full h-36">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={interactionChartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                              <defs>
                                <linearGradient id="colorTotalMessages" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.35}/>
                                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0.0}/>
                                </linearGradient>
                                <linearGradient id="colorUserInteractions" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#f97316" stopOpacity={0.35}/>
                                  <stop offset="95%" stopColor="#f97316" stopOpacity={0.0}/>
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                              <XAxis dataKey="date" stroke="rgba(255,255,255,0.25)" fontSize={8} tickLine={false} axisLine={false} />
                              <YAxis stroke="rgba(255,255,255,0.25)" fontSize={8} tickLine={false} axisLine={false} allowDecimals={false} />
                              <Tooltip 
                                contentStyle={{ 
                                  backgroundColor: '#111111', 
                                  borderColor: 'rgba(255,255,255,0.08)',
                                  borderRadius: '0.5rem',
                                  fontSize: '9px',
                                  fontFamily: 'monospace'
                                }}
                                itemStyle={{ color: '#fff' }}
                              />
                              <Area type="monotone" dataKey="Total Messages" stroke="#a855f7" strokeWidth={1.5} fillOpacity={1} fill="url(#colorTotalMessages)" />
                              <Area type="monotone" dataKey="User Interactions" stroke="#f97316" strokeWidth={1} fillOpacity={1} fill="url(#colorUserInteractions)" />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      {/* Real-time search/filter inputs */}
                      <div className="relative select-text">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                        <input
                          type="text"
                          placeholder="Search conversational memories..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder-white/35 focus:outline-none focus:border-purple-500/50 transition-all font-mono"
                        />
                        {searchQuery && (
                          <button
                            onClick={() => setSearchQuery("")}
                            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] text-white/30 hover:text-white"
                          >
                            Clear
                          </button>
                        )}
                      </div>

                      {/* Scrollable Conversation Logs Timeline Feed */}
                      {(() => {
                        const filteredHistory = messages.filter(msg => {
                          if (!searchQuery.trim()) return true;
                          return msg.text.toLowerCase().includes(searchQuery.toLowerCase());
                        });

                        return (
                          <div className="flex-grow overflow-y-auto max-h-[350px] pr-1.5 custom-scrollbar space-y-4 select-text">
                            {filteredHistory.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-10 text-center">
                                <Database className="w-10 h-10 text-white/10 mb-3" />
                                <p className="text-xs text-white/30 font-light italic">No matching persistent memories found.</p>
                              </div>
                            ) : (
                              (() => {
                                const grouped = groupMessagesByDay(filteredHistory);
                                return Object.entries(grouped).map(([dayLabel, dayMsgs]) => (
                                  <div key={dayLabel} className="space-y-3">
                                    <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-widest text-purple-400/70 border-b border-white/5 pb-1">
                                      <Calendar className="w-3.5 h-3.5 text-purple-500" />
                                      {dayLabel}
                                    </div>
                                    
                                    <div className="space-y-2">
                                      {dayMsgs.map((msg) => (
                                        <div 
                                          key={msg.id} 
                                          className="bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl p-3 transition-colors space-y-1 text-left"
                                        >
                                          <div className="flex justify-between items-center text-[8px] font-mono uppercase tracking-widest">
                                            <span className={msg.role === 'user' ? 'text-orange-400 font-bold' : 'text-emerald-400 font-bold'}>
                                              {msg.role === 'user' ? 'You' : 'Echo'}
                                            </span>
                                            {msg.timestamp && (
                                              <span className="text-white/30 font-extralight text-[8px]">
                                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                              </span>
                                            )}
                                          </div>
                                          {msg.images && msg.images.length > 0 && (
                                            <div className="flex flex-wrap gap-1 my-1 justify-start">
                                              {msg.images.map((img, idx) => (
                                                <div key={idx} className="relative rounded overflow-hidden border border-white/5 max-w-[80px] max-h-[60px] shadow-sm bg-black/25">
                                                  <img 
                                                    src={img.url} 
                                                    alt={`mem-attachment-${idx}`} 
                                                    className="object-contain max-w-full h-auto max-h-[60px]"
                                                    referrerPolicy="no-referrer"
                                                  />
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          <p className="text-xs text-white/80 leading-relaxed font-sans select-all font-light whitespace-pre-wrap">
                                            {cleanTextForDisplay(msg.text)}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ));
                              })()
                            )}
                          </div>
                        );
                      })()}

                      {/* Clear Database Card Panel Action */}
                      <div className="bg-red-500/5 border border-red-500/10 rounded-2xl p-4 flex flex-col gap-3 shrink-0">
                        <div className="flex items-center gap-2 text-red-500/80">
                          <Trash2 className="w-4 h-4 shrink-0" />
                          <span className="text-[10px] font-sans font-bold uppercase tracking-wider">Secure Clear Actions</span>
                        </div>
                        <p className="text-[10px] text-white/40 leading-relaxed">
                          Need to empty cached records? Use this prompt to initiate full authorization checkpoints. Resets all daily text parameters.
                        </p>
                        <button
                          onClick={() => setShowClearConfirmModal(true)}
                          className="w-full py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider bg-red-500/10 border border-red-500/25 hover:bg-red-500 hover:text-white text-red-400 transition-all shadow-sm"
                        >
                          Empty Memory Database
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Secure Clear All Memory Confirmation Dialog Overlay */}
      <AnimatePresence>
        {showClearConfirmModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowClearConfirmModal(false)}
              className="absolute inset-0 bg-black"
            />

            {/* Modal Box */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="relative bg-[#121212] border border-white/10 rounded-2xl p-6 shadow-2xl max-w-sm w-full space-y-4 text-center z-10"
            >
              <div className="mx-auto w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center border border-red-500/20 text-red-500">
                <Trash2 className="w-5 h-5 animate-pulse" />
              </div>

              <div className="space-y-1 text-left">
                <h3 className="text-sm font-black text-white uppercase tracking-widest text-center">Wipe Conversational Memory?</h3>
                <p className="text-[11px] text-white/50 leading-relaxed text-center">
                  This secure action will wipe your local persistent state history. Past memories, scripts, and logs cannot be recovered.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowClearConfirmModal(false)}
                  className="flex-1 px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider border border-white/10 text-white/60 hover:bg-white/5 transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMessages([]);
                    setCodeOutput(null);
                    setLiveUserSubtitle("");
                    setLiveModelSubtitle("");
                    localStorage.removeItem('echo_messages_v2');
                    setShowClearConfirmModal(false);
                    speakNotification("Chat dynamic memories fully flushed and cleared friend!");
                  }}
                  className="flex-1 px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider bg-red-500 text-white hover:bg-red-600 transition-all shadow-md cursor-pointer"
                >
                  Confirm wipe
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Interactive Commands Center Modal */}
      <AnimatePresence>
        {showCommandsModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowCommandsModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-md"
            />

            {/* Modal Body */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ type: "spring", duration: 0.5 }}
              className="relative w-full max-w-xl bg-neutral-950/90 border border-white/10 rounded-3xl p-6 sm:p-8 shadow-[0_0_50px_rgba(16,185,129,0.15)] overflow-hidden z-10"
            >
              {/* Decorative side accent glow */}
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10" />
              <div className="absolute bottom-0 left-0 w-32 h-32 bg-orange-500/5 rounded-full blur-3xl -ml-10 -mb-10" />

              {/* Header */}
              <div className="flex items-start justify-between mb-6 relative">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-emerald-500/10 rounded-2xl border border-emerald-500/20 text-emerald-400">
                    <Terminal className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                      Interactive Commands
                      <span className="text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded uppercase tracking-wide">
                        Command Mode
                      </span>
                    </h2>
                    <p className="text-xs text-white/40 mt-1">
                      Whisper vocal prompts or click shortcut bullets to command Echo.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowCommandsModal(false)}
                  className="p-1.5 rounded-xl bg-white/5 text-white/40 hover:bg-white/10 hover:text-white transition-all border border-white/5"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Commands List Grid */}
              <div className="space-y-3.5 max-h-[55vh] overflow-y-auto pr-1.5 custom-scrollbar relative">
                
                {/* 1. Mute/Unmute */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[mute]</span>
                      <h3 className="text-xs font-bold text-white/90">Toggle Microphone</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"mute microphone"</code> or <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"stop listening"</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setIsMuted(!isMuted);
                    }}
                    className={`px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider border transition-all self-start sm:self-auto ${
                      isMuted 
                        ? 'bg-red-500/20 border-red-500/30 text-red-400 hover:bg-red-500/30' 
                        : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {isMuted ? 'Unmute' : 'Mute'}
                  </button>
                </div>

                {/* 2. Switch Mode */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[switch mode]</span>
                      <h3 className="text-xs font-bold text-white/90">Switch App Persona</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"switch to programmer mode"</code> or <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"switch to friend mode"</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setAppMode(appMode === 'friend' ? 'programmer' : 'friend');
                    }}
                    className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 hover:text-white transition-all self-start sm:self-auto"
                  >
                    Set to {appMode === 'friend' ? 'Programmer' : 'Friend'}
                  </button>
                </div>

                {/* 3. Voice Assist */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[voice assist]</span>
                      <h3 className="text-xs font-bold text-white/90">Voice Speech Output</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"enable voice assist"</code> or <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"disable voice assist"</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setIsVoiceAssist(!isVoiceAssist);
                    }}
                    className={`px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider border transition-all self-start sm:self-auto ${
                      isVoiceAssist 
                        ? 'bg-orange-500/20 border-orange-500/30 text-orange-400 hover:bg-orange-500/30' 
                        : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {isVoiceAssist ? 'Disable' : 'Enable'}
                  </button>
                </div>

                {/* 4. Clear Chat */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[clear chat]</span>
                      <h3 className="text-xs font-bold text-white/90">Wipe Chat Session</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"clear chat"</code> or <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"clear history"</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setMessages([]);
                      setCodeOutput(null);
                    }}
                    className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 transition-all self-start sm:self-auto"
                  >
                    Clear Chat
                  </button>
                </div>

                {/* 5. End Session */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[stop session]</span>
                      <h3 className="text-xs font-bold text-white/90">Disconnect Voice Pipeline</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"stop session"</code> or <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"end session"</code>.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (isConnected) {
                        stopLiveSession();
                      } else {
                        toggleConnection();
                      }
                    }}
                    disabled={isStarting}
                    className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 hover:text-white transition-all self-start sm:self-auto disabled:opacity-50"
                  >
                    {isConnected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>

                {/* 6. Dismiss Command Mode */}
                <div className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:bg-white/10 group">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-black text-emerald-400 uppercase tracking-widest">[deactivate]</span>
                      <h3 className="text-xs font-bold text-white/90">Exit Command Mode</h3>
                    </div>
                    <p className="text-[11px] text-white/50 leading-relaxed">
                      Vocal cue: <code className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-1 py-0.5 rounded">"deactivate command mode"</code>. Return to casual chat.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setIsCommandMode(false);
                      setShowCommandsModal(false);
                    }}
                    className="px-4 py-2 rounded-xl text-[10px] uppercase font-bold tracking-wider bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/25 transition-all self-start sm:self-auto"
                  >
                    Exit Cmd Mode
                  </button>
                </div>

              </div>

              {/* Informative Footer */}
              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between text-[10px] text-white/35">
                <span className="flex items-center gap-1.5"><Terminal className="w-3 h-3 text-emerald-400" /> Responses are optimized for terminal rendering speed.</span>
                <button 
                  onClick={() => setShowCommandsModal(false)}
                  className="hover:text-white transition-all font-bold uppercase tracking-wider"
                >
                  Got It
                </button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="mt-8 sm:mt-12 text-white/30 text-[9px] sm:text-[10px] tracking-widest uppercase flex items-center gap-4">
        <div className="h-px w-8 sm:w-12 bg-white/10" />
        Live Streaming Voice Assistant
        <div className="h-px w-8 sm:w-12 bg-white/10" />
      </div>
    </div>
  );
}
