'use client';

import { useEffect, useRef, useState } from 'react';
import { C, FONT } from '@/lib/theme';
import Icon from './Icon';

interface ShelfScannerProps {
  /** @deprecated — the viewport now uses an aspect ratio instead of a fixed height. */
  height?: number;
  capturedPreview?: string | null;
  onCapture: (file: File) => void;
  /** Receives one OR many files — Upload now supports multi-select from
   *  the gallery so a worker can ship a whole aisle (15+ shots) in one tap. */
  onUpload: (files: File[]) => void;
}

type Mode = 'idle' | 'starting' | 'live' | 'captured' | 'denied' | 'unavailable';

export default function ShelfScanner({
  capturedPreview,
  onCapture,
  onUpload,
}: ShelfScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Start idle with NO viewport — the frame only appears once the worker taps
  // "Take photo" (live camera). Upload never shows a frame at all.
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => stopStream(), []);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const startCamera = async () => {
    setError(null);
    setMode('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('unavailable');
      setError('Camera not supported in this browser. Use Upload photo instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setMode('live');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/denied|not allowed|permission/i.test(msg)) setMode('denied');
      else setMode('unavailable');
      setError(msg);
    }
  };

  const capture = () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;

    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    c.toBlob(
      blob => {
        if (!blob) return;
        const file = new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
        stopStream();
        setMode('idle');
        onCapture(file);
      },
      'image/jpeg',
      0.92
    );
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    // Keep only images — without an accept filter, "Choose Files" could
    // otherwise hand us a PDF etc.
    const arr: File[] = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].type.startsWith('image/')) arr.push(list[i]);
    }
    e.target.value = ''; // allow re-selecting the same files later
    if (arr.length === 0) return;
    stopStream();
    setMode('idle');
    onUpload(arr);
  };

  return (
    <div style={{ fontFamily: FONT }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '3 / 4',
          maxHeight: '70vh',
          borderRadius: 22,
          overflow: 'hidden',
          background: '#1a221c',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
          // The viewport only exists while the camera is active (or erroring).
          // Idle = no frame, so the shelf picker + buttons aren't crowded out.
          display: mode === 'idle' ? 'none' : 'block',
        }}
      >
        {/* Captured / preview frame */}
        {mode === 'captured' && capturedPreview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={capturedPreview}
            alt="shelf"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}

        {/* Live camera video (kept mounted so srcObject sticks) */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: mode === 'live' ? 'block' : 'none',
          }}
        />

        {/* Idle placeholder */}
        {mode === 'idle' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              background: `repeating-linear-gradient(135deg, #2a221c 0 14px, #221c16 14px 28px)`,
              color: '#e0b04a',
            }}
          >
            <Icon name="camera" size={42} />
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }}>
              Tap to start scanning the shelf
            </div>
          </div>
        )}

        {/* Starting (granting permission) */}
        {mode === 'starting' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#cfdcc6',
              fontSize: 13,
              fontWeight: 500,
              gap: 8,
            }}
          >
            <Icon name="dots" size={20} />
            Waking the camera…
          </div>
        )}

        {/* Permission denied / unavailable */}
        {(mode === 'denied' || mode === 'unavailable') && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 22,
              textAlign: 'center',
              color: '#e9d6a6',
              gap: 10,
            }}
          >
            <Icon name="camera" size={32} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {mode === 'denied' ? 'Camera permission blocked' : 'Camera unavailable'}
            </div>
            <div style={{ fontSize: 12.5, color: '#bfb392', maxWidth: 280, lineHeight: 1.4 }}>
              Use <strong>Upload photo</strong> instead, or allow camera in your browser settings and tap retry.
            </div>
            <button
              onClick={startCamera}
              style={{
                marginTop: 4, padding: '6px 14px', borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.2)', background: 'transparent',
                color: '#e9d6a6', fontFamily: FONT, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >Retry</button>
          </div>
        )}

        {/* Click-to-start full-bleed button on idle */}
        {mode === 'idle' && (
          <button
            onClick={startCamera}
            aria-label="Start scanning"
            style={{
              position: 'absolute', inset: 0,
              background: 'transparent', border: 'none', cursor: 'pointer',
            }}
          />
        )}

        {/* Live-mode overlay: scanning line + corner brackets + capture button */}
        {mode === 'live' && (
          <>
            {/* corner brackets */}
            <Bracket position="tl" />
            <Bracket position="tr" />
            <Bracket position="bl" />
            <Bracket position="br" />

            {/* scanning line */}
            <div
              style={{
                position: 'absolute',
                left: 18,
                right: 18,
                top: 0,
                height: 2,
                background: `linear-gradient(90deg, transparent 0%, ${C.primary}cc 25%, #c3e8b0 50%, ${C.primary}cc 75%, transparent 100%)`,
                boxShadow: `0 0 18px 2px ${C.primary}cc`,
                animation: 'scanline 2.4s cubic-bezier(.6,0,.4,1) infinite',
                pointerEvents: 'none',
                borderRadius: 2,
              }}
            />

            {/* subtle vignette */}
            <div
              style={{
                position: 'absolute', inset: 0,
                background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%)',
                pointerEvents: 'none',
              }}
            />

            {/* helper text */}
            <div
              style={{
                position: 'absolute',
                left: 0, right: 0, top: 16,
                textAlign: 'center', color: '#e2f0d8',
                fontSize: 12, fontWeight: 600, letterSpacing: 0.4,
                textShadow: '0 1px 4px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
              }}
            >
              Hold steady — bear is watching
            </div>

            {/* capture shutter */}
            <button
              onClick={capture}
              aria-label="Capture frame"
              style={{
                position: 'absolute',
                bottom: 14, left: '50%', transform: 'translateX(-50%)',
                width: 64, height: 64, borderRadius: 32,
                background: '#fff', border: `4px solid ${C.primary}`,
                cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}
            >
              <div style={{
                width: 44, height: 44, borderRadius: 22, background: C.primary,
              }} />
            </button>
          </>
        )}

        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>

      {/* Action row below the viewport */}
      {/* No `accept="image/*"` on purpose: that attribute is what makes iOS add
          the redundant "Take Photo" option to its file action sheet. We have a
          dedicated Take-photo button, so dropping it leaves iOS showing mostly
          Photo Library (+ Choose Files). onFile filters to images defensively. */}
      <input
        ref={uploadRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={onFile}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        {mode === 'live' ? (
          <button
            onClick={() => { stopStream(); setMode('idle'); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
              padding: '14px 0', background: C.white, border: `1px solid ${C.border}`,
              borderRadius: 14, fontFamily: FONT, fontSize: 14.5, fontWeight: 600,
              color: C.primaryDark, cursor: 'pointer',
            }}
          >
            <Icon name="x" size={18} style={{ color: C.primaryDark }} />
            Cancel
          </button>
        ) : (
          <button
            onClick={startCamera}
            disabled={mode === 'starting'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
              padding: '14px 0', background: C.white, border: `1px solid ${C.border}`,
              borderRadius: 14, fontFamily: FONT, fontSize: 14.5, fontWeight: 600,
              color: C.primaryDark, cursor: mode === 'starting' ? 'wait' : 'pointer',
              opacity: mode === 'starting' ? 0.6 : 1,
            }}
          >
            <Icon name="camera" size={18} style={{ color: C.primaryDark }} />
            {mode === 'starting' ? 'Starting…' : 'Take photo'}
          </button>
        )}

        <button
          onClick={() => uploadRef.current?.click()}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            padding: '14px 0', background: C.white, border: `1px solid ${C.border}`,
            borderRadius: 14, fontFamily: FONT, fontSize: 14.5, fontWeight: 600,
            color: C.primaryDark, cursor: 'pointer',
          }}
        >
          <Icon name="image" size={18} style={{ color: C.primaryDark }} />
          Upload photos
        </button>
      </div>

      {error && mode !== 'denied' && mode !== 'unavailable' && (
        <div style={{
          marginTop: 8, padding: '8px 12px', background: '#fee', borderRadius: 10,
          color: '#933', fontSize: 12, fontWeight: 500,
        }}>{error}</div>
      )}
    </div>
  );
}

function Bracket({ position }: { position: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base: React.CSSProperties = {
    position: 'absolute',
    width: 28, height: 28,
    borderColor: '#c3e8b0',
    pointerEvents: 'none',
    filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.4))',
  };
  const styleByPos: Record<typeof position, React.CSSProperties> = {
    tl: { ...base, top: 14, left: 14, borderTop: '3px solid', borderLeft: '3px solid', borderTopLeftRadius: 8 },
    tr: { ...base, top: 14, right: 14, borderTop: '3px solid', borderRight: '3px solid', borderTopRightRadius: 8 },
    bl: { ...base, bottom: 14, left: 14, borderBottom: '3px solid', borderLeft: '3px solid', borderBottomLeftRadius: 8 },
    br: { ...base, bottom: 14, right: 14, borderBottom: '3px solid', borderRight: '3px solid', borderBottomRightRadius: 8 },
  };
  return <div style={styleByPos[position]} />;
}
