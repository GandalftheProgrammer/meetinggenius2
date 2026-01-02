
import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadTextToDrive, uploadAudioToDrive, disconnectDrive } from './services/driveService';
import { clearSession } from './services/storageService';
import { AlertCircle, Loader2, Calendar } from 'lucide-react';

const App: React.FC = () => {
  const generateDefaultTitle = () => {
    const now = new Date();
    const dateStr = now.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return `Meeting - ${dateStr} ${timeStr}`;
  };

  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>(generateDefaultTitle());
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString().split(' ')[0]} ${msg}`]);
  }, []);

  useEffect(() => {
    initDrive((token) => {
        setIsDriveConnected(!!token);
    });
  }, []);

  const handleConnectDrive = () => {
      const storedName = localStorage.getItem('drive_folder_name');
      if (storedName) {
          connectToDrive();
      } else {
          const folderName = prompt("Drive mapnaam voor backups:", "MeetingGenius");
          if (folderName) {
              localStorage.setItem('drive_folder_name', folderName);
              connectToDrive();
          }
      }
  };

  const handleRecordingFinished = (blob: Blob) => {
      if (!blob || blob.size < 100) {
          setError("De opname is mislukt of bevat geen data. Probeer het opnieuw.");
          return;
      }
      setCombinedBlob(blob);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(URL.createObjectURL(blob));
      setAppState(AppState.PAUSED);
  };

  const handleFileUpload = (file: File) => {
      handleRecordingFinished(file);
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
  };

  const handleManualAudioSave = async () => {
      if (!combinedBlob) return;
      try {
          await uploadAudioToDrive(title || "Ongetiteld", combinedBlob);
          addLog("Audio opgeslagen in Drive");
      } catch (err) {
          addLog("Opslaan audio mislukt");
      }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    setError(null);
    if (!combinedBlob) {
        setError("Geen audio gevonden om te verwerken.");
        return;
    }
    
    const currentTitle = title.trim() || generateDefaultTitle();
    setTitle(currentTitle);
    
    setAppState(AppState.PROCESSING);
    try {
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type, mode, selectedModel, addLog);
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      
      if (isDriveConnected && newData.summary) {
          await uploadTextToDrive(`${currentTitle}_samenvatting`, newData.summary, 'Notes');
      }
    } catch (apiError: any) {
      setError(apiError.message || "Er is iets misgegaan tijdens de verwerking.");
      setAppState(AppState.PAUSED); 
    }
  };

  const handleDiscard = async () => {
    await clearSession();
    setAppState(AppState.IDLE);
    setCombinedBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setMeetingData(null);
    setTitle(generateDefaultTitle());
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header isDriveConnected={isDriveConnected} onConnectDrive={handleConnectDrive} onDisconnectDrive={disconnectDrive} selectedModel={selectedModel} onModelChange={setSelectedModel} />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8">
        
        {error && (
            <div className="max-w-lg mx-auto mb-6 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-center gap-3 animate-in fade-in zoom-in duration-300">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm font-medium">{error}</p>
                <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600 font-bold">×</button>
            </div>
        )}

        {appState === AppState.PROCESSING ? (
            <div className="flex flex-col items-center justify-center py-20 space-y-6">
                <div className="relative">
                    <div className="w-24 h-24 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
                    <Loader2 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 text-blue-600 animate-pulse" />
                </div>
                <div className="text-center space-y-2">
                    <h2 className="text-xl font-bold text-slate-800">AI analyseert de meeting...</h2>
                    <p className="text-slate-500 max-w-xs mx-auto text-sm">Dit duurt ongeveer 30-60 seconden.</p>
                </div>
            </div>
        ) : appState !== AppState.COMPLETED ? (
          <div className="flex flex-col items-center space-y-8">
            <div className="w-full max-w-lg space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider ml-1 flex items-center gap-2">
                <Calendar className="w-3.5 h-3.5" /> Meeting Titel
              </label>
              <input 
                type="text" 
                value={title} 
                onChange={(e) => setTitle(e.target.value)} 
                className="w-full px-5 py-4 rounded-2xl border border-slate-200 shadow-sm focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all bg-white text-lg font-medium text-slate-800" 
              />
            </div>

            <Recorder 
              appState={appState} 
              onProcessAudio={handleProcessAudio} 
              onDiscard={handleDiscard} 
              onRecordingChange={(isRec) => setAppState(isRec ? AppState.RECORDING : AppState.PAUSED)} 
              onSaveAudio={handleManualAudioSave} 
              onFileUpload={handleFileUpload} 
              audioUrl={audioUrl} 
              debugLogs={debugLogs}
              meetingTitle={title}
              onRecordingFinished={handleRecordingFinished}
            />
          </div>
        ) : meetingData && (
          <Results data={meetingData} title={title} onReset={handleDiscard} onGenerateMissing={handleProcessAudio} isProcessingMissing={false} onSaveAudio={handleManualAudioSave} />
        )}
      </main>
      <footer className="py-6 text-center text-slate-400 text-xs font-medium">MeetingGenius AI Assistant &bull; {new Date().getFullYear()}</footer>
    </div>
  );
};

export default App;
