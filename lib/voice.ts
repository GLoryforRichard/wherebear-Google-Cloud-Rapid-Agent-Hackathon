'use client';

/**
 * Client-side push-to-talk recorder.
 *
 * Why this instead of the Web Speech API: browser speech recognition is weak
 * on accents, multilingual input, and noisy environments (a grocery floor).
 * We record raw audio and hand it to Gemini on the server, which is far more
 * robust to accents and can use store context to clean up the transcript.
 *
 * Pipeline: getUserMedia → MediaRecorder → decode → re-render to 16kHz mono
 * WAV (small upload, speech-grade, and a format Gemini definitely accepts).
 */

import { useRef, useState, useCallback, useEffect } from 'react';

// Guard against a stuck finger uploading a huge clip.
const MAX_RECORDING_MS = 15_000;

export function getVoiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const AC = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  // Cast so the optional-ness is visible to TS — the DOM lib types declare
  // these as always-present, but they're missing on old browsers and in
  // non-secure (http) contexts.
  const nav = navigator as Navigator & { mediaDevices?: MediaDevices };
  return !!(nav.mediaDevices && typeof window.MediaRecorder !== 'undefined' && AC);
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Encode a mono AudioBuffer as a 16-bit PCM WAV blob. */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const dataSize = samples.length * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Decode a recorded blob and re-render it to 16kHz mono WAV. */
async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer();
  const AC = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC();
  const decoded = await decodeCtx.decodeAudioData(arrayBuf);
  decodeCtx.close();

  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const OAC = window.OfflineAudioContext
    || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const off = new OAC(1, frames, targetRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return audioBufferToWav(rendered);
}

export function useVoiceRecorder(
  onWav: (wav: Blob) => void,
  onError: (code: string) => void,
) {
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWavRef = useRef(onWav);
  const onErrorRef = useRef(onError);
  const [recording, setRecording] = useState(false);

  useEffect(() => { onWavRef.current = onWav; onErrorRef.current = onError; });

  const start = useCallback(async () => {
    if (mrRef.current && mrRef.current.state === 'recording') return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onErrorRef.current('mic-denied');
      return;
    }
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      onErrorRef.current('unsupported');
      return;
    }
    chunksRef.current = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      const raw = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
      if (raw.size === 0) { onErrorRef.current('empty'); return; }
      try {
        const wav = await blobToWav(raw);
        onWavRef.current(wav);
      } catch {
        onErrorRef.current('decode');
      }
    };
    mr.start();
    mrRef.current = mr;
    setRecording(true);
    timerRef.current = setTimeout(() => {
      try { if (mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);
  }, []);

  const stop = useCallback(() => {
    setRecording(false);
    const mr = mrRef.current;
    try { if (mr && mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ }
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try { const mr = mrRef.current; if (mr && mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ }
  }, []);

  return { start, stop, recording };
}
