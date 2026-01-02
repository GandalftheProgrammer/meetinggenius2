
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Loader2, MonitorPlay, Trash2, Circle, FileAudio, ListChecks, FileText, CheckCircle, Upload } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode } from '../types';

const SILENT_AUDIO_URI = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////wAAADFMYXZjNTguNTQuAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAxIirAAAA//OEAAAAAAAAAAAAAAAAAAAAAAA';

interface RecorderProps {
  appState: AppState;
  onChunkReady: (blob: Blob) => void;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
  onFileUpload: (file: File) => void;
  audioUrl: string | null;
  debugLogs: string[];
}

type AudioSource = 'microphone' | 'system';

const Recorder: React.FC<RecorderProps> = ({ 
  appState, 
  onChunkReady, 
  onProcessAudio, 
  onDiscard,
  onRecordingChange,
  onFileUpload,
  audioUrl, 
  debugLogs 
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll for logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [debugLogs]);

  const cleanupResources = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
    }
  };

  const getSupportedMimeType = () => {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/aac'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return undefined;
  };

  const startRecording = async () => {
    try {
      if (silentAudioRef.current) {
          silentAudioRef.current.play().then(() => {
             if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Meeting Recording',
                    artist: 'MeetingGenius'
                });
                navigator.mediaSession.playbackState = 'playing';
            }
          }).catch(() => {});
      }

      let finalStream: MediaStream;
      if (audioSource === 'system') {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } 
          });
          const sysAudioTracks = displayStream.getAudioTracks();
          if (sysAudioTracks.length === 0) {
            alert("No audio shared! Make sure to check 'Share tab audio'.");
            displayStream.getTracks().forEach(t => t.stop());
            if (silentAudioRef.current) silentAudioRef.current.pause();
            return;
          }
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          audioContextRef.current = audioCtx;
          const sysSource = audioCtx.createMediaStreamSource(displayStream);
          const micSource = audioCtx.createMediaStreamSource(micStream);
          const dest = audioCtx.createMediaStreamDestination();
          sysSource.connect(dest);
          micSource.connect(dest);
          finalStream = dest.stream;
          sysAudioTracks[0].onended = () => stopRecording();
          streamRef.current = displayStream; 
        } catch (err) {
          if (silentAudioRef.current) silentAudioRef.current.pause();
          return; 
        }
      } else {
        finalStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        streamRef.current = finalStream;
      }
      
      setStream(finalStream);
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(finalStream, { mimeType, audioBitsPerSecond: 64000 });
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) onChunkReady(e.data); };
      mediaRecorder.start(1000); 
      setIsRecording(true);
      onRecordingChange(true);
      const startTime = Date.now() - (recordingTime * 1000);
      timerRef.current = window.setInterval(() => { setRecordingTime(Math.floor((Date.now() - startTime) / 1000)); }, 1000);
    } catch (error) {
      alert("Microphone access denied.");
      if (silentAudioRef.current) silentAudioRef.current.pause();
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      cleanupResources();
      if (silentAudioRef.current) {
          silentAudioRef.current.pause();
          silentAudioRef.current.currentTime = 0;
      }
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
      setStream(null);
      streamRef.current = null;
      setIsRecording(false);
      onRecordingChange(false);
    }
  }, [onRecordingChange]);

  const toggleRecording = () => isRecording ? stopRecording() : startRecording();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) onFileUpload(e.target.files[0]);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isProcessing = appState === AppState.PROCESSING;
  const hasRecordedData = audioUrl !== null;

  if (isProcessing) {
    return (
      <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
         <div className="flex flex-col items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
            <div className="text-center">
              <p className="text-slate-800 font-bold text-xl tracking-tight">AI Pipeline Active</p>
              <p className="text-slate-500 text-sm font-medium">Please wait while we process your meeting...</p>
            </div>
         </div>
         <div className="w-full bg-slate-900 text-slate-300 p-4 rounded-xl text-[11px] font-mono h-48 overflow-y-auto custom-scrollbar border border-slate-800 shadow-inner">
            {debugLogs.length > 0 ? (
              <>
                {debugLogs.map((log, i) => (
                  <div key={i} className="mb-1 opacity-90 border-b border-slate-800 pb-1 last:border-0">
                    <span className="text-blue-400 mr-2">[{i+1}]</span>
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </>
            ) : (
              <div className="text-slate-600">Waiting for first log...</div>
            )}
         </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center transition-all duration-300 hover:shadow-2xl">
      {!isMobile && (
        <div className={`w-full mb-6 transition-opacity duration-300 ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
          <div className="flex bg-slate-100 p-1 rounded-lg w-full">
            <button
              onClick={() => setAudioSource('microphone')}
              disabled={isRecording}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all ${
                audioSource === 'microphone' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Mic className="w-4 h-4" />
              Microphone
            </button>
            <button
              onClick={() => setAudioSource('system')}
              disabled={isRecording}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all ${
                audioSource === 'system' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <MonitorPlay className="w-4 h-4" />
              System + Mic
            </button>
          </div>
        </div>
      )}

      <div className="w-full h-24 mb-6 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 overflow-hidden relative">
        {isRecording || hasRecordedData ? <AudioVisualizer stream={stream} isRecording={isRecording} /> : <div className="text-slate-400 text-sm font-medium">Ready to record</div>}
      </div>

      <div className={`text-5xl font-mono font-semibold mb-8 tracking-wider ${isRecording ? 'text-red-500' : 'text-slate-700'}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full mb-6 gap-4">
        <div className="relative">
             <button
              onClick={toggleRecording}
              className={`group relative flex items-center justify-center w-20 h-20 rounded-full shadow-md transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-offset-2 ${
                isRecording ? 'bg-slate-900 hover:bg-slate-800 focus:ring-slate-200' : 'bg-red-500 hover:bg-red-600 focus:ring-red-200'
              }`}
            >
              {isRecording ? <Square className="w-8 h-8 text-white fill-current" /> : audioSource === 'system' ? <MonitorPlay className="w-8 h-8 text-white" /> : <Circle className="w-8 h-8 text-white fill-current" />}
            </button>
        </div>
        {!isRecording && !hasRecordedData && (
            <div>
                <input type="file" accept="audio/*,.mp3,.wav,.m4a,.mp4,.aac,.webm,.ogg,.flac" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium transition-colors px-4 py-2 rounded-full hover:bg-blue-50">
                    <Upload className="w-4 h-4" />
                    Upload Audio File
                </button>
            </div>
        )}
        <p className="mt-2 text-slate-400 text-sm font-medium">
          {isRecording ? "Recording..." : hasRecordedData ? "Paused" : "Start Recording or Upload"}
        </p>
      </div>

      {!isRecording && hasRecordedData && (
        <div className="w-full border-t border-slate-100 pt-6 animate-in slide-in-from-top-4 duration-300 text-center">
          {audioUrl && (
            <div className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 mb-6 flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate-500 ml-1 uppercase tracking-wide text-left">Preview</span>
              <audio controls src={audioUrl} className="w-full h-8" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 w-full mb-3">
            <button onClick={() => onProcessAudio('NOTES_ONLY')} className="flex flex-col items-center justify-center p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all group text-blue-700 shadow-sm">
              <ListChecks className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
              <span className="font-bold text-sm">Summary</span>
            </button>
            <button onClick={() => onProcessAudio('TRANSCRIPT_ONLY')} className="flex flex-col items-center justify-center p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-xl transition-all group text-purple-700 shadow-sm">
              <FileText className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
              <span className="font-bold text-sm">Transcription</span>
            </button>
          </div>
          <button onClick={onDiscard} className="w-full py-2 px-4 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors flex items-center justify-center gap-2">
            <Trash2 className="w-4 h-4" />
            Discard & Start Over
          </button>
        </div>
      )}
    </div>
  );
};

export default Recorder;
