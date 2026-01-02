
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Loader2, MonitorPlay, Trash2, Circle, FileAudio, ListChecks, FileText, CheckCircle, Upload, ShieldCheck, CloudUpload } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode } from '../types';
import { saveChunk, startNewSession, markSessionComplete, recoverAudio } from '../services/storageService';

const SILENT_AUDIO_URI = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////wAAADFMYXZjNTguNTQuAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAxIirAAAA//OEAAAAAAAAAAAAAAAAAAAAAAA';

interface RecorderProps {
  appState: AppState;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
  onSaveAudio?: (isAutoBackup?: boolean) => Promise<void>;
  onFileUpload: (file: File) => void;
  audioUrl: string | null;
  debugLogs: string[];
  meetingTitle: string;
  onRecordingFinished: (blob: Blob) => void;
}

const Recorder: React.FC<RecorderProps> = ({ 
  appState, 
  onProcessAudio, 
  onDiscard,
  onRecordingChange,
  onSaveAudio,
  onFileUpload,
  audioUrl, 
  debugLogs,
  meetingTitle,
  onRecordingFinished
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioSource, setAudioSource] = useState<'microphone' | 'system'>('microphone');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [lastAutoBackup, setLastAutoBackup] = useState<number>(0);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const backupTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingWritesRef = useRef<number>(0);

  useEffect(() => {
    if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setIsMobile(true);
    }
    
    const audio = new Audio(SILENT_AUDIO_URI);
    audio.loop = true;
    audio.volume = 0.01;
    silentAudioRef.current = audio;

    return () => {
      cleanupResources();
      if (silentAudioRef.current) {
          silentAudioRef.current.pause();
          silentAudioRef.current = null;
      }
    };
  }, []);

  const getSupportedMimeType = () => {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/wav'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return 'audio/webm'; // fallback
  };

  const cleanupResources = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (backupTimerRef.current) clearInterval(backupTimerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
    }
  };

  const startRecording = async () => {
    try {
      await startNewSession(meetingTitle);
      
      if (silentAudioRef.current) {
          silentAudioRef.current.play().catch(console.warn);
      }

      let finalStream: MediaStream;
      if (audioSource === 'system') {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
        const dest = audioCtx.createMediaStreamDestination();
        audioCtx.createMediaStreamSource(displayStream).connect(dest);
        audioCtx.createMediaStreamSource(micStream).connect(dest);
        finalStream = dest.stream;
        streamRef.current = displayStream;
      } else {
        finalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = finalStream;
      }
      
      setStream(finalStream);
      
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(finalStream, { mimeType, audioBitsPerSecond: 128000 });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          pendingWritesRef.current++;
          try {
            await saveChunk(e.data);
          } finally {
            pendingWritesRef.current--;
          }
        }
      };

      mediaRecorder.start(3000); // Kortere chunks (3s) voor betere stabiliteit
      setIsRecording(true);
      onRecordingChange(true);
      
      const start = Date.now();
      timerRef.current = window.setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - start) / 1000));
      }, 1000);

      backupTimerRef.current = window.setInterval(async () => {
        if (onSaveAudio) {
            await onSaveAudio(true);
            setLastAutoBackup(Date.now());
        }
      }, 120000);

    } catch (error) {
      console.error("Recording error:", error);
      alert("Kon de opname niet starten. Controleer je microfoon-rechten.");
    }
  };

  const stopRecording = useCallback(async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      const recorder = mediaRecorderRef.current;
      
      const stopPromise = new Promise(resolve => {
          recorder.onstop = resolve;
          recorder.stop();
      });

      await stopPromise;

      // WACOHT op alle lopende IndexedDB schrijfacties
      let waitAttempts = 0;
      while (pendingWritesRef.current > 0 && waitAttempts < 50) {
          await new Promise(r => setTimeout(r, 100));
          waitAttempts++;
      }

      await markSessionComplete();
      
      if (silentAudioRef.current) silentAudioRef.current.pause();

      const recovered = await recoverAudio();
      if (recovered && recovered.blob.size > 1000) {
          onRecordingFinished(recovered.blob);
      } else {
          alert("De opname is mislukt of te kort. Probeer het opnieuw.");
      }

      cleanupResources();
      setStream(null);
      setIsRecording(false);
      onRecordingChange(false);
    }
  }, [onRecordingChange, onRecordingFinished]);

  const toggleRecording = () => isRecording ? stopRecording() : startRecording();

  const handleManualSave = async () => {
      if (!onSaveAudio) return;
      setIsSaving(true);
      try {
          await onSaveAudio();
          setIsSaved(true);
          setTimeout(() => setIsSaved(false), 3000);
      } finally { setIsSaving(false); }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center">
      
      {!isRecording && !audioUrl && (
        <div className="w-full mb-6">
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button onClick={() => setAudioSource('microphone')} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium ${audioSource === 'microphone' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'}`}><Mic className="w-4 h-4 inline mr-2"/>Mic</button>
            {!isMobile && <button onClick={() => setAudioSource('system')} className={`flex-1 py-2 px-4 rounded-md text-sm font-medium ${audioSource === 'system' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'}`}><MonitorPlay className="w-4 h-4 inline mr-2"/>Systeem</button>}
          </div>
        </div>
      )}

      <div className="w-full h-24 mb-6 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 overflow-hidden relative">
        <AudioVisualizer stream={stream} isRecording={isRecording} />
        {isRecording && (
            <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-green-500/10 text-green-600 text-[10px] font-bold rounded-full border border-green-500/20 animate-pulse">
                <ShieldCheck className="w-3 h-3" /> BEVEILIGING ACTIEF
            </div>
        )}
      </div>

      <div className={`text-5xl font-mono font-semibold mb-2 ${isRecording ? 'text-red-500' : 'text-slate-700'}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full mb-6 gap-4">
        <button onClick={toggleRecording} className={`w-20 h-20 rounded-full shadow-md flex items-center justify-center transition-all ${isRecording ? 'bg-slate-900 hover:bg-slate-800' : 'bg-red-500 hover:bg-red-600'}`}>
          {isRecording ? <Square className="w-8 h-8 text-white fill-current" /> : <Circle className="w-8 h-8 text-white fill-current" />}
        </button>
        
        {!isRecording && !audioUrl && (
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium">
                <Upload className="w-4 h-4" /> Upload Bestand
                <input type="file" accept="audio/*" ref={fileInputRef} onChange={(e) => e.target.files?.[0] && onFileUpload(e.target.files[0])} className="hidden" />
            </button>
        )}
      </div>

      {!isRecording && audioUrl && (
        <div className="w-full border-t border-slate-100 pt-6 animate-in slide-in-from-top-4">
          <audio controls src={audioUrl} className="w-full h-10 mb-6 shadow-sm rounded-lg" />
          <div className="grid grid-cols-2 gap-3 mb-3">
            <button onClick={() => onProcessAudio('NOTES_ONLY')} className="p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl text-blue-700 font-semibold text-sm flex flex-col items-center"><ListChecks className="mb-1"/>Samenvatten</button>
            <button onClick={() => onProcessAudio('TRANSCRIPT_ONLY')} className="p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-xl text-purple-700 font-semibold text-sm flex flex-col items-center"><FileText className="mb-1"/>Transcript</button>
          </div>
          {onSaveAudio && (
              <button onClick={handleManualSave} disabled={isSaving || isSaved} className={`w-full py-2 px-4 rounded-lg text-sm font-medium flex items-center justify-center gap-2 border ${isSaved ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                 {isSaving ? <Loader2 className="animate-spin w-4 h-4"/> : isSaved ? <CheckCircle className="w-4 h-4"/> : <FileAudio className="w-4 h-4"/>}
                 {isSaved ? "In Drive!" : "Save naar Drive"}
              </button>
          )}
          <button onClick={onDiscard} className="w-full mt-3 py-2 text-sm text-red-500 font-medium flex items-center justify-center gap-2 hover:bg-red-50 rounded-lg transition-colors"><Trash2 className="w-4 h-4" /> Weggooien</button>
        </div>
      )}
    </div>
  );
};

export default Recorder;
