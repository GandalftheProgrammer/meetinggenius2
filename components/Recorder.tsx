
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Loader2, MonitorPlay, AlertCircle, FileText, ListChecks, Trash2, Circle } from 'lucide-react';
import AudioVisualizer from './AudioVisualizer';
import { AppState, ProcessingMode } from '../types';

interface RecorderProps {
  appState: AppState;
  onChunkReady: (blob: Blob) => void;
  onProcessAudio: (mode: ProcessingMode) => void;
  onDiscard: () => void;
  onRecordingChange: (isRecording: boolean) => void;
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

  useEffect(() => {
    // @ts-ignore 
    if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setIsMobile(true);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

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
      let mediaStream: MediaStream;

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

          const audioTracks = displayStream.getAudioTracks();
          if (audioTracks.length === 0) {
            alert("No audio shared! Please ensure you check the 'Share tab audio' box in the browser popup.");
            displayStream.getTracks().forEach(t => t.stop());
            return;
          }

          mediaStream = new MediaStream([audioTracks[0]]);
          audioTracks[0].onended = () => stopRecording();
          streamRef.current = displayStream;
        } catch (err) {
          console.error("Error getting display media:", err);
          return; 
        }
      } else {
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } 
        });
        streamRef.current = mediaStream;
      }
      
      setStream(mediaStream);
      const mimeType = getSupportedMimeType();
      
      const options: MediaRecorderOptions = {
        mimeType,
        audioBitsPerSecond: 32000 
      };
      
      const mediaRecorder = new MediaRecorder(mediaStream, options);
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
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      setStream(null);
      streamRef.current = null;
      setIsRecording(false);
      onRecordingChange(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [recordingTime, onRecordingChange]);

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isProcessing = appState === AppState.PROCESSING;
  const hasRecordedData = audioUrl !== null;

  // Use same max-width for both states to prevent jumping
  if (isProcessing) {
    return (
      <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-8 flex flex-col items-center">
         <div className="flex flex-col items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
            <div className="text-center">
              <p className="text-slate-800 font-semibold text-lg">Processing with Gemini 3</p>
              <p className="text-slate-500 text-sm">Uploading & Analyzing audio...</p>
            </div>
         </div>
         {debugLogs.length > 0 && (
           <div className="w-full bg-slate-900 text-slate-300 p-3 rounded-lg text-xs font-mono max-h-32 overflow-y-auto custom-scrollbar">
              {debugLogs.map((log, i) => (
                <div key={i} className="border-b border-slate-800 last:border-0 py-1">
                  {log}
                </div>
              ))}
           </div>
         )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 p-6 md:p-8 flex flex-col items-center transition-all duration-300 hover:shadow-2xl">
      
      {!isRecording && !isMobile && (
        <div className="w-full mb-6">
          <div className="flex bg-slate-100 p-1 rounded-lg w-full">
            <button
              onClick={() => setAudioSource('microphone')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all ${
                audioSource === 'microphone' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Mic className="w-4 h-4" />
              Microphone
            </button>
            <button
              onClick={() => setAudioSource('system')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-all ${
                audioSource === 'system' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <MonitorPlay className="w-4 h-4" />
              System / Tab
            </button>
          </div>
          
           <div className="mt-2 text-center">
             {audioSource === 'microphone' ? (
               <p className="text-xs text-slate-400">In-person meetings or Desktop Apps (Zoom/Teams) via speakers.</p>
             ) : (
               <p className="text-xs text-slate-400">Browser tabs (Meet, YouTube) via direct audio capture.</p>
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

      <div className="flex flex-col items-center justify-center w-full mb-6">
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
            audioSource === 'system' ? <MonitorPlay className="w-8 h-8 text-white" /> : <Circle className="w-8 h-8 text-white fill-current" />
          )}
        </button>
        
        <p className="mt-4 text-slate-400 text-sm font-medium">
          {isRecording ? "Recording..." : hasRecordedData ? "Paused" : "Press to start"}
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

          <div className="grid grid-cols-2 gap-3 w-full mb-4">
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
                    {log}
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
