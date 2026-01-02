
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, MonitorPlay, Trash2, Circle, ListChecks, FileText, Upload } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode } from '../types';

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
  meetingTitle,
  onRecordingFinished
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioSource, setAudioSource] = useState<'microphone' | 'system'>('microphone');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setIsMobile(true);
    }
    return () => {
        if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const stopTracks = (s: MediaStream | null) => {
    if (s) s.getTracks().forEach(t => t.stop());
  };

  const startRecording = async () => {
    try {
      audioChunksRef.current = [];
      let finalStream: MediaStream;

      if (audioSource === 'system') {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();
        audioCtx.createMediaStreamSource(displayStream).connect(dest);
        audioCtx.createMediaStreamSource(micStream).connect(dest);
        finalStream = dest.stream;
      } else {
        finalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      
      setStream(finalStream);
      
      // Kies het formaat dat de browser ondersteunt
      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? { mimeType: 'audio/webm;codecs=opus' } 
        : MediaRecorder.isTypeSupported('audio/mp4') 
          ? { mimeType: 'audio/mp4' } 
          : undefined;

      const recorder = new MediaRecorder(finalStream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: audioChunksRef.current[0]?.type || 'audio/webm' });
        onRecordingFinished(blob);
        stopTracks(finalStream);
      };

      recorder.start(1000);
      setIsRecording(true);
      onRecordingChange(true);
      
      setRecordingTime(0);
      const startTime = Date.now();
      timerRef.current = window.setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

    } catch (error) {
      console.error("Microfoon fout:", error);
      alert("Kon de microfoon niet activeren. Controleer of je toestemming hebt gegeven.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      onRecordingChange(false);
      if (timerRef.current) clearInterval(timerRef.current);
      setStream(null);
    }
  };

  const toggleRecording = () => isRecording ? stopRecording() : startRecording();

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-lg mx-auto bg-white rounded-3xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
      
      {!isRecording && !audioUrl && (
        <div className="w-full mb-8">
          <div className="flex bg-slate-100 p-1.5 rounded-2xl">
            <button onClick={() => setAudioSource('microphone')} className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${audioSource === 'microphone' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}>
              <Mic className="w-4 h-4 inline mr-2"/>Microfoon
            </button>
            {!isMobile && (
              <button onClick={() => setAudioSource('system')} className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${audioSource === 'system' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}>
                <MonitorPlay className="w-4 h-4 inline mr-2"/>Systeem
              </button>
            )}
          </div>
        </div>
      )}

      <div className="w-full h-32 mb-8 bg-slate-50 rounded-2xl flex items-center justify-center border-2 border-slate-100 overflow-hidden relative">
        <AudioVisualizer stream={stream} isRecording={isRecording} />
        {isRecording && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1.5 bg-red-500 text-white text-[10px] font-black rounded-full shadow-lg animate-pulse">
                <Circle className="w-3 h-3 fill-current" /> REC
            </div>
        )}
      </div>

      <div className={`text-6xl font-mono font-bold mb-8 tracking-tighter transition-colors ${isRecording ? 'text-red-500' : 'text-slate-800'}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full mb-8 gap-6">
        <button 
          onClick={toggleRecording} 
          className={`w-24 h-24 rounded-full shadow-xl flex items-center justify-center transition-all active:scale-95 ${isRecording ? 'bg-slate-900 hover:bg-black ring-8 ring-slate-50' : 'bg-red-500 hover:bg-red-600 ring-8 ring-red-50'}`}
        >
          {isRecording ? <Square className="w-10 h-10 text-white fill-current" /> : <Circle className="w-10 h-10 text-white fill-current" />}
        </button>
        
        {!isRecording && !audioUrl && (
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 text-slate-400 hover:text-blue-600 text-sm font-bold transition-colors">
                <Upload className="w-4 h-4" /> OF IMPORT EEN BESTAND
                <input type="file" accept="audio/*" ref={fileInputRef} onChange={(e) => e.target.files?.[0] && onFileUpload(e.target.files[0])} className="hidden" />
            </button>
        )}
      </div>

      {!isRecording && audioUrl && (
        <div className="w-full border-t border-slate-100 pt-8 animate-in slide-in-from-bottom-4">
          <audio controls src={audioUrl} className="w-full h-12 mb-8 shadow-sm rounded-xl" />
          <div className="grid grid-cols-2 gap-4 mb-4">
            <button onClick={() => onProcessAudio('NOTES_ONLY')} className="p-4 bg-blue-600 hover:bg-blue-700 rounded-2xl text-white font-bold text-sm flex flex-col items-center gap-2 shadow-lg transition-all active:scale-95">
              <ListChecks className="w-5 h-5"/>Samenvatten
            </button>
            <button onClick={() => onProcessAudio('TRANSCRIPT_ONLY')} className="p-4 bg-purple-600 hover:bg-purple-700 rounded-2xl text-white font-bold text-sm flex flex-col items-center gap-2 shadow-lg transition-all active:scale-95">
              <FileText className="w-5 h-5"/>Transcript
            </button>
          </div>
          <button onClick={onDiscard} className="w-full mt-4 py-3 text-sm text-red-500 font-bold flex items-center justify-center gap-2 hover:bg-red-50 rounded-xl transition-colors">
            <Trash2 className="w-4 h-4" /> Opname Verwijderen
          </button>
        </div>
      )}
    </div>
  );
};

export default Recorder;
