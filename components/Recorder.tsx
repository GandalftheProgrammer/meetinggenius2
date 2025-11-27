
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Loader2, MonitorPlay, Trash2, Circle, FileAudio, ListChecks, FileText, CheckCircle, Upload } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode } from '../types';

// Tiny silent MP3 to keep the Audio Session active on mobile
const SILENT_AUDIO_URI = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////wAAADFMYXZjNTguNTQuAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAAxIirAAAA//OEAAAAAAAAAAAAAAAAAAAAAAA';

interface RecorderProps {
  appState: AppState;
  onChunkReady: (blob: Blob) => void;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
  onSaveAudio?: () => Promise<void>;
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
  onSaveAudio,
  onFileUpload,
  audioUrl, 
  debugLogs 
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Silent Audio Player Ref
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // @ts-ignore 
    if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setIsMobile(true);
    }

    // Create the silent audio element
    const audio = new Audio(SILENT_AUDIO_URI);
    audio.loop = true;
    audio.volume = 0.01; // Non-zero volume is required for iOS to consider it "playing"
    // Helper attributes for iOS/Android background playback
    audio.setAttribute('playsinline', 'true');
    audio.setAttribute('webkit-playsinline', 'true');
    audio.preload = 'auto';
    silentAudioRef.current = audio;

    // Handle visibility change to re-acquire resources if dropped
    const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
            // Resume Audio Context if suspended
            if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }
        }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cleanupResources();
      if (silentAudioRef.current) {
          silentAudioRef.current.pause();
          silentAudioRef.current = null;
      }
    };
  }, [isRecording]);

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
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/aac'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return undefined;
  };

  const startRecording = async () => {
    try {
      // Attempt Silent Loop Hack (Fail-safe)
      // Execute immediately to latch onto the user gesture
      if (silentAudioRef.current) {
          silentAudioRef.current.play().catch(err => {
              console.warn("Silent audio hack failed (ignoring, proceeding with recording):", err);
          });
      }

      let finalStream: MediaStream;

      if (audioSource === 'system') {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            } 
          });

          const sysAudioTracks = displayStream.getAudioTracks();
          if (sysAudioTracks.length === 0) {
            alert("No audio shared! Please ensure you check the 'Share tab audio' box.");
            displayStream.getTracks().forEach(t => t.stop());
            if (silentAudioRef.current) silentAudioRef.current.pause();
            return;
          }

          const micStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
               echoCancellation: true,
               noiseSuppression: true
            }
          });

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
          console.error("Error setting up mixed audio:", err);
          if (silentAudioRef.current) silentAudioRef.current.pause();
          return; 
        }
      } else {
        // Standard Microphone Request
        finalStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } 
        });
        streamRef.current = finalStream;
      }
      
      setStream(finalStream);
      const mimeType = getSupportedMimeType();
      
      const options: MediaRecorderOptions = {
        mimeType,
        audioBitsPerSecond: 64000
      };
      
      const mediaRecorder = new MediaRecorder(finalStream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          onChunkReady(e.data);
        }
      };

      mediaRecorder.start(1000); 
      
      setIsRecording(true);
      onRecordingChange(true);
      
      const startTime = Date.now() - (recordingTime * 1000);
      timerRef.current = window.setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

    } catch (error) {
      console.error("Error accessing audio:", error);
      alert("Could not access audio device. Please check permissions.");
      if (silentAudioRef.current) silentAudioRef.current.pause();
    }
  };

  const stopRecording = useCallback(async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      cleanupResources();
      
      // Stop the Silent Loop
      if (silentAudioRef.current) {
          silentAudioRef.current.pause();
          silentAudioRef.current.currentTime = 0;
      }

      setStream(null);
      streamRef.current = null;
      setIsRecording(false);
      onRecordingChange(false);
    }
  }, [recordingTime, onRecordingChange]);

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const handleManualSave = async () => {
      if (!onSaveAudio) return;
      setIsSaving(true);
      try {
          await onSaveAudio();
          setIsSaved(true);
          setTimeout(() => setIsSaved(false), 3000);
      } finally {
          setIsSaving(false);
      }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
        onFileUpload(e.target.files[0]);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isProcessing = appState === AppState.PROCESSING;
  const hasRecordedData = audioUrl !== null;

  const renderLog = (log: string) => {
    if (log.includes('http')) {
      const parts = log.split(/(https?:\/\/[^\s]+)/g);
      return (
        <span>
          {parts.map((part, i) => 
            part.match(/^https?:\/\//) ? (
              <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">
                {part.includes('drive.google') ? 'View File' : 'Link'}
              </a>
            ) : (
              part
            )
          )}
        </span>
      );
    }
    return log;
  };

  if (isProcessing) {
    return (
      <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
         <div className="flex flex-col items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
            <div className="text-center">
              <p className="text-slate-800 font-semibold text-lg">Processing Audio</p>
              <p className="text-slate-500 text-sm">Uploading & Analyzing...</p>
            </div>
         </div>
         {debugLogs.length > 0 && (
           <div className="w-full bg-slate-900 text-slate-300 p-3 rounded-lg text-xs font-mono max-h-32 overflow-y-auto custom-scrollbar">
              {debugLogs.map((log, i) => (
                <div key={i} className="border-b border-slate-800 last:border-0 py-1">
                  {renderLog(log)}
                </div>
              ))}
           </div>
         )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center transition-all duration-300 hover:shadow-2xl">
      
      {/* Source Selection */}
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
          
           <div className="mt-2 text-center">
             {audioSource === 'microphone' ? (
               <p className="text-xs text-slate-400">In-person meetings or Desktop Apps (Zoom/Teams) via speakers.</p>
             ) : (
               <p className="text-xs text-slate-400">Records Browser Tab/Window audio AND your microphone simultaneously.</p>
             )}
          </div>
        </div>
      )}

      {isMobile && !isRecording && (
         <div className="mb-6 text-center">
           <span className="text-xs text-slate-400 bg-slate-50 px-2 py-1 rounded-full border border-slate-100">Mobile optimized</span>
         </div>
      )}

      {/* Visualization Area */}
      <div className="w-full h-24 mb-6 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 overflow-hidden relative">
        {isRecording || hasRecordedData ? (
          <AudioVisualizer stream={stream} isRecording={isRecording} />
        ) : (
          <div className="text-slate-400 text-sm font-medium">Ready to record</div>
        )}
      </div>

      <div className={`text-5xl font-mono font-semibold mb-8 tracking-wider ${isRecording ? 'text-red-500' : 'text-slate-700'}`}>
        {formatTime(recordingTime)}
      </div>

      <div className="flex flex-col items-center justify-center w-full mb-6 gap-4">
        {/* Record Button */}
        <div className="relative">
             <button
              onClick={toggleRecording}
              className={`group relative flex items-center justify-center w-20 h-20 rounded-full shadow-md transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-offset-2 ${
                isRecording 
                  ? 'bg-slate-900 hover:bg-slate-800 focus:ring-slate-200' 
                  : 'bg-red-500 hover:bg-red-600 focus:ring-red-200'
              }`}
            >
              {isRecording ? (
                <Square className="w-8 h-8 text-white fill-current" />
              ) : (
                audioSource === 'system' ? 
                  <MonitorPlay className="w-8 h-8 text-white" /> : 
                  <Circle className="w-8 h-8 text-white fill-current" />
              )}
            </button>
        </div>
        
        {/* Upload Button */}
        {!isRecording && !hasRecordedData && (
            <div>
                <input 
                    type="file" 
                    // Support wider range of audio formats explicitly for mobile
                    accept="audio/*,.mp3,.wav,.m4a,.mp4,.aac,.webm,.ogg,.flac"
                    ref={fileInputRef} 
                    onChange={handleFileSelect} 
                    className="hidden" 
                />
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 text-slate-500 hover:text-blue-600 text-sm font-medium transition-colors px-4 py-2 rounded-full hover:bg-blue-50"
                >
                    <Upload className="w-4 h-4" />
                    Upload Audio File
                </button>
            </div>
        )}

        <p className="mt-2 text-slate-400 text-sm font-medium">
          {isRecording ? "Recording..." : hasRecordedData ? "Paused" : "Press to start or Upload"}
        </p>
      </div>

      {!isRecording && hasRecordedData && (
        <div className="w-full border-t border-slate-100 pt-6 animate-in slide-in-from-top-4 duration-300">
          {audioUrl && (
            <div className="w-full bg-slate-50 p-3 rounded-xl border border-slate-200 mb-6 flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate-500 ml-1 uppercase tracking-wide">Preview</span>
              <audio controls src={audioUrl} className="w-full h-8" />
            </div>
          )}
          
          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3 w-full mb-3">
            <button
              onClick={() => onProcessAudio('NOTES_ONLY')}
              className="flex flex-col items-center justify-center p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all group text-blue-700"
            >
              <ListChecks className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
              <span className="font-semibold text-sm">Summary</span>
            </button>

            <button
              onClick={() => onProcessAudio('TRANSCRIPT_ONLY')}
              className="flex flex-col items-center justify-center p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-xl transition-all group text-purple-700"
            >
              <FileText className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
              <span className="font-semibold text-sm">Transcript</span>
            </button>
          </div>

          {/* New Audio Save Button */}
          {onSaveAudio && (
              <button
                onClick={handleManualSave}
                disabled={isSaving || isSaved}
                className={`w-full mb-3 py-2 px-4 rounded-lg text-sm font-medium transition-all shadow-sm flex items-center justify-center gap-2 ${
                    isSaved 
                    ? 'bg-green-50 border-green-200 text-green-700 border' 
                    : 'bg-white border-slate-200 text-slate-700 border hover:bg-slate-50'
                }`}
              >
                 {isSaving ? <Loader2 className="w-4 h-4 animate-spin"/> : isSaved ? <CheckCircle className="w-4 h-4"/> : <FileAudio className="w-4 h-4"/>}
                 {isSaved ? "Saved to Drive!" : "Save Audio to Drive"}
              </button>
          )}

          <button
            onClick={onDiscard}
            className="w-full py-2 px-4 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 hover:text-red-700 border border-transparent hover:border-red-100 transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Discard & Start Over
          </button>

          {debugLogs.length > 0 && (
             <div className="w-full mt-4 bg-slate-50 text-slate-400 p-2 rounded border border-slate-100 text-[10px] font-mono max-h-20 overflow-y-auto custom-scrollbar">
                {debugLogs.map((log, i) => (
                  <div key={i} className="border-b border-slate-200 last:border-0 py-0.5">
                    {renderLog(log)}
                  </div>
                ))}
             </div>
           )}
        </div>
      )}
    </div>
  );
};

export default Recorder;
