
import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadTextToDrive, uploadAudioToDrive, disconnectDrive } from './services/driveService';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash-lite');
  
  // Data State
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Audio State
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  // Processing State
  const [isGeneratingMissing, setIsGeneratingMissing] = useState(false);
  
  // Upload State
  const [isUploadedFile, setIsUploadedFile] = useState(false);
  
  // Date State for Timestamping
  const [recordingStartTime, setRecordingStartTime] = useState<Date | null>(null);
  const [uploadedFileDate, setUploadedFileDate] = useState<Date | null>(null);
  
  // Drive State
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  
  // Logs
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString().split(' ')[0]} ${msg}`]);
  };

  // Initialize Drive on mount with better state handling
  useEffect(() => {
    const timer = setTimeout(() => {
      initDrive((token) => {
          if (token) {
              setIsDriveConnected(true);
              addLog("Google Drive: Sessie hersteld");
          } else {
              setIsDriveConnected(false);
          }
      });
    }, 500); // Small delay to ensure Google script is ready
    return () => clearTimeout(timer);
  }, []);

  const handleConnectDrive = () => {
      const storedName = localStorage.getItem('drive_folder_name');
      if (storedName) {
          connectToDrive();
      } else {
          const folderName = prompt("Kies een Google Drive mapnaam voor je data:", "MeetingGenius");
          if (folderName) {
              localStorage.setItem('drive_folder_name', folderName);
              connectToDrive();
          }
      }
  };

  const handleDisconnectDrive = () => {
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Google Drive: Verbinding verbroken");
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
      addLog(`Bestand geüpload: ${file.name}`);
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

  const getFormattedDateTime = (dateInput?: Date) => {
      const now = dateInput || new Date();
      return now.toLocaleString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const saveAudioBackup = async () => {
    if (!combinedBlob || !isDriveConnected) return;
    const currentTitle = title.trim() || `Meeting ${getFormattedDateTime()}`;
    const safeTitle = currentTitle.replace(/[^a-z0-9\s-]/gi, '_');
    try {
        addLog("Audio back-up starten...");
        const result = await uploadAudioToDrive(safeTitle, combinedBlob);
        if (result.webViewLink) addLog(`Audio bewaard: ${result.webViewLink}`);
    } catch (err) {
        addLog("Waarschuwing: Audio back-up mislukt.");
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob) return;
    let baseDate = (isUploadedFile && uploadedFileDate) ? uploadedFileDate : (recordingStartTime || new Date());
    const timestamp = getFormattedDateTime(baseDate);
    let currentTitle = title.trim() || `Meeting ${timestamp}`;
    if (title.trim() && !currentTitle.includes(timestamp)) {
        currentTitle = `${currentTitle} - ${timestamp}`;
    }
    setTitle(currentTitle);

    if (appState === AppState.COMPLETED) {
      setIsGeneratingMissing(true);
    } else {
      setAppState(AppState.PROCESSING);
      if (!isUploadedFile) saveAudioBackup();
    }
    
    try {
      addLog(`AI Model: ${selectedModel}`);
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', mode, selectedModel, addLog);
      
      const updatedData = meetingData ? {
          ...meetingData,
          transcription: newData.transcription || meetingData.transcription,
          summary: newData.summary || meetingData.summary,
          conclusions: newData.conclusions.length > 0 ? newData.conclusions : meetingData.conclusions,
          actionItems: newData.actionItems.length > 0 ? newData.actionItems : meetingData.actionItems
      } : newData;
      
      setMeetingData(updatedData);
      setAppState(AppState.COMPLETED);
    } catch (apiError) {
      addLog(`Fout: ${apiError instanceof Error ? apiError.message : 'Onbekend'}`);
      setError("Verwerking mislukt. Bekijk de logs.");
      setAppState(AppState.PAUSED); 
    } finally {
      setIsGeneratingMissing(false);
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
    setIsUploadedFile(false);
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
              <label htmlFor="title" className="block text-sm font-medium text-slate-700 ml-1">Titel van de meeting</label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Bijv. Project Kickoff"
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
              onSaveAudio={isDriveConnected ? saveAudioBackup : undefined}
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
            onSaveAudio={isDriveConnected ? saveAudioBackup : undefined}
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
