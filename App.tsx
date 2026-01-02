
import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive } from './services/driveService';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-3-flash-preview');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  const [isGeneratingMissing, setIsGeneratingMissing] = useState(false);
  
  const [isUploadedFile, setIsUploadedFile] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState<Date | null>(null);
  const [uploadedFileDate, setUploadedFileDate] = useState<Date | null>(null);
  
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} ${msg}`]);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      initDrive((token) => {
          if (token) {
              setIsDriveConnected(true);
              addLog("Drive link active.");
          } else {
              setIsDriveConnected(false);
          }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const handleConnectDrive = () => {
      const storedName = localStorage.getItem('drive_folder_name');
      if (storedName) {
          connectToDrive();
      } else {
          const folderName = prompt("Drive folder name?", "MeetingGenius");
          if (folderName) {
              localStorage.setItem('drive_folder_name', folderName);
              connectToDrive();
          }
      }
  };

  const handleDisconnectDrive = () => {
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Drive disconnected.");
  };

  useEffect(() => {
    if (audioChunks.length > 0) {
      const mimeType = audioChunks[0].type || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });
      setCombinedBlob(blob);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [audioChunks]);

  const handleChunkReady = (chunk: Blob) => {
    setAudioChunks(prev => [...prev, chunk]);
  };

  const handleFileUpload = (file: File) => {
      setAudioChunks([]); 
      setCombinedBlob(file);
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      setIsUploadedFile(true);
      setUploadedFileDate(new Date(file.lastModified));
      setAppState(AppState.PAUSED);
      addLog(`New file: ${file.name}`);
      if (!title) {
          setTitle(file.name.replace(/\.[^/.]+$/, ""));
      }
  };

  const handleRecordingChange = (isRecording: boolean) => {
    if (isRecording) {
      setRecordingStartTime(new Date());
      setIsUploadedFile(false);
      setAppState(AppState.RECORDING);
    } else {
       if (appState === AppState.RECORDING) {
         setAppState(AppState.PAUSED);
       }
    }
  };

  const autoSyncToDrive = async (data: MeetingData, currentTitle: string, blob: Blob | null) => {
    if (!isDriveConnected) return;
    
    const safeTitle = currentTitle.replace(/[/\\?%*:|"<>]/g, '-');
    addLog("Initiating Drive cloud sync...");

    // 1. Audio
    if (blob) {
      uploadAudioToDrive(safeTitle, blob)
        .then(() => addLog("Audio synced successfully."))
        .catch(e => addLog("Audio sync failed."));
    }

    // 2. Notes
    if (data.summary) {
      const notesMarkdown = `# Notes: ${currentTitle}\n\n${data.summary}\n\n## Action Items\n${data.actionItems.map(i => `- ${i}`).join('\n')}`;
      uploadTextToDrive(`${safeTitle} Notes`, notesMarkdown, 'Notes')
        .then(() => addLog("Notes synced successfully."))
        .catch(e => addLog("Notes sync failed."));
    }

    // 3. Transcript
    if (data.transcription) {
      uploadTextToDrive(`${safeTitle} Transcript`, `# Transcript: ${currentTitle}\n\n${data.transcription}`, 'Transcripts')
        .then(() => addLog("Transcript synced successfully."))
        .catch(e => addLog("Transcript sync failed."));
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob) return;
    
    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "New Meeting";
    setTitle(finalTitle);

    setAppState(AppState.PROCESSING);

    try {
      addLog(`Starting background analysis (requested: ${mode})...`);
      // We always process EVERYTHING ('ALL') in the background
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', 'ALL', selectedModel, addLog);
      
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);

      if (isDriveConnected) {
        autoSyncToDrive(newData, finalTitle, combinedBlob);
      }
    } catch (apiError) {
      addLog(`Critical Error: ${apiError instanceof Error ? apiError.message : 'Unknown'}`);
      setError("Analysis failed.");
      setAppState(AppState.PAUSED); 
    }
  };

  const handleDiscard = () => {
    setAppState(AppState.IDLE);
    setAudioChunks([]);
    setCombinedBlob(null);
    setAudioUrl(null);
    setMeetingData(null);
    setDebugLogs([]);
    setTitle("");
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        onConnectDrive={handleConnectDrive} 
        onDisconnectDrive={handleDisconnectDrive}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
        {error && (
          <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl text-center text-sm">
            {error}
          </div>
        )}
        {appState !== AppState.COMPLETED && (
          <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
            <div className="w-full max-w-lg space-y-2">
              <label htmlFor="title" className="block text-sm font-medium text-slate-700 ml-1">Title</label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="f.i. Project Update"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
                disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
              />
            </div>
            <Recorder 
              appState={appState}
              onChunkReady={handleChunkReady}
              onProcessAudio={handleProcessAudio}
              onDiscard={handleDiscard}
              onRecordingChange={handleRecordingChange}
              onFileUpload={handleFileUpload}
              audioUrl={audioUrl}
              debugLogs={debugLogs}
            />
          </div>
        )}
        {appState === AppState.COMPLETED && meetingData && (
          <Results 
            data={meetingData} 
            title={title} 
            onReset={handleDiscard}
            onGenerateMissing={handleProcessAudio}
            isProcessingMissing={isGeneratingMissing} 
            isDriveConnected={isDriveConnected}
            onConnectDrive={handleConnectDrive}
            audioBlob={combinedBlob}
            initialMode={lastRequestedMode}
          />
        )}
      </main>
      <footer className="py-6 text-center text-slate-400 text-sm">
        &copy; {new Date().getFullYear()} MeetingGenius.
      </footer>
    </div>
  );
};

export default App;
