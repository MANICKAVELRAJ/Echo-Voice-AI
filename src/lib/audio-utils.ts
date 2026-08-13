/**
 * Audio utilities for PCM encoding/decoding and Web Audio API management.
 */

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];

  constructor(private onAudioData?: (base64Data: string) => void) {}

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  async start(isStreaming: boolean = true) {
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    
    // Enable browser-level audio enhancements
    this.stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      } 
    });
    
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.chunks = [];
    
    // 1. High-pass filter to remove low-frequency rumble (below 100Hz)
    const highPass = this.audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 100;

    // 2. Low-pass filter to remove high-frequency hiss (above 4000Hz)
    // Most human speech is contained below 4kHz
    const lowPass = this.audioContext.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 4000;

    // 3. Peaking filter to boost speech "presence" (around 2.5kHz)
    const presenceBoost = this.audioContext.createBiquadFilter();
    presenceBoost.type = 'peaking';
    presenceBoost.frequency.value = 2500;
    presenceBoost.Q.value = 1;
    presenceBoost.gain.value = 4; // +4dB boost for clarity

    // 4. Dynamics compressor to normalize volume levels
    const compressor = this.audioContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-24, this.audioContext.currentTime);
    compressor.knee.setValueAtTime(30, this.audioContext.currentTime);
    compressor.ratio.setValueAtTime(12, this.audioContext.currentTime);
    compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
    compressor.release.setValueAtTime(0.25, this.audioContext.currentTime);

    // 5. Gain node to ensure healthy signal levels
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 1.2; // Slight boost

    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      if (isStreaming && this.onAudioData) {
        const pcmData = this.floatTo16BitPCM(inputData);
        const base64Data = this.arrayBufferToBase64(pcmData);
        this.onAudioData(base64Data);
      } else {
        // Store for later processing
        this.chunks.push(new Float32Array(inputData));
      }
    };

    // Connect the chain: Source -> Highpass -> Lowpass -> Presence -> Compressor -> Gain -> Processor -> Destination
    this.source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(presenceBoost);
    presenceBoost.connect(compressor);
    compressor.connect(gainNode);
    gainNode.connect(this.analyser);
    gainNode.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async stop(): Promise<string | null> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    
    let base64Data: string | null = null;
    if (this.chunks.length > 0) {
      const totalLength = this.chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of this.chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      const pcmData = this.floatTo16BitPCM(combined);
      base64Data = this.arrayBufferToBase64(pcmData);
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
    this.audioContext = null;
    this.chunks = [];
    
    return base64Data;
  }

  private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime: number = 0;
  private playbackRate: number = 1.0;

  constructor() {
    this.initContext();
  }

  private initContext() {
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.audioContext.destination);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = rate;
  }

  async playChunk(base64Data: string) {
    if (!this.audioContext) {
      this.initContext();
    }
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
    const audioContext = this.audioContext!;

    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const pcmData = new Int16Array(bytes.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 0x8000;
    }

    const audioBuffer = audioContext.createBuffer(1, floatData.length, 24000);
    audioBuffer.getChannelData(0).set(floatData);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.playbackRate;
    
    if (this.analyser) {
      source.connect(this.analyser);
    } else {
      source.connect(audioContext.destination);
    }

    const currentTime = audioContext.currentTime;
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }

    source.start(this.nextStartTime);
    // Adjust next start time based on playback rate
    this.nextStartTime += audioBuffer.duration / this.playbackRate;
  }

  async stop() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
    this.initContext();
    this.nextStartTime = 0;
  }
}
