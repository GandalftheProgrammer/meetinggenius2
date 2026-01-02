
import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadTextToDrive, uploadAudioToDrive, disconnectDrive } from './services/driveService';
import { getActiveSession, recoverAudio, clearSession } from './services/storageService';
import { AlertCircle, RotateCcw, Trash2, Loader2 } from 'lucide-react';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recoveryData, setRecoveryData] = useState<{blob: Blob, title: string} | null>(null);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString().split(' ')[0]} ${msg}`]);
  }, []);

  useEffect(() => {
    const checkRecovery = async () => {
        const active = await getActiveSession();
        if (active) {
            const recovered = await recoverAudio();
            if (recovered) {
                setRecoveryData({ blob: recovered.blob, title: recovered.metadata.title });
            }
        }
    };
    checkRecovery();
  }, []);

  useEffect(() => {
    initDrive((token) => {
        setIsDriveConnected(!!token);
    });
  }, []);

  const handleApplyRecovery = () => {
      if (!recoveryData) return;
      handleRecordingFinished(recoveryData.blob);
      setTitle(recoveryData.title);
      setAppState(AppState.PAUSED);
      setRecoveryData(null);
  };

  const handleDiscardRecovery = async () => {
      await clearSession();
      setRecoveryData(null);
  };

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
      setCombinedBlob(blob);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(URL.createObjectURL(blob));
  };

  const handleFileUpload = (file: File) => {
      handleRecordingFinished(file);
      setAppState(AppState.PAUSED);
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
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
    let blob = combinedBlob;
    if (!blob) {
        const recovered = await recoverAudio();
        if (recovered) {
            blob = recovered.blob;
            handleRecordingFinished(blob);
        }
    }
    
    if (!blob) return;
    const currentTitle = title.trim() || `Meeting ${new Date().toLocaleString()}`;
    setTitle(currentTitle);
    
    setAppState(AppState.PROCESSING);
    try {
      const newData = await processMeetingAudio(blob, blob.type, mode, selectedModel, addLog);
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      
      if (isDriveConnected && newData.summary) {
          await uploadTextToDrive(`${currentTitle}_samenvatting`, newData.summary, 'Notes');
      }
      await clearSession();
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
    setTitle("");
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header isDriveConnected={isDriveConnected} onConnectDrive={handleConnectDrive} onDisconnectDrive={disconnectDrive} selectedModel={selectedModel} onModelChange={setSelectedModel} />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8">
        
        {recoveryData && appState === AppState.IDLE && (
            <div className="max-w-lg mx-auto mb-8 bg-blue-600 text-white p-4 rounded-2xl shadow-lg flex items-center justify-between animate-in slide-in-from-top-4">
                <div className="flex items-center gap-3">
                    <AlertCircle className="w-6 h-6 shrink-0"/>
                    <div>
                        <p className="font-bold text-sm">Herstel opname</p>
                        <p className="text-xs opacity-90">"{recoveryData.title}" is beschikbaar.</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button onClick={handleDiscardRecovery} className="p-2 hover:bg-red-500 rounded-lg transition-colors"><Trash2 className="w-4 h-4"/></button>
                    <button onClick={handleApplyRecovery} className="bg-white text-blue-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-100 transition-colors"><RotateCcw className="w-3.5 h-3.5"/> Herstel</button>
                </div>
            </div>
        )}

        {error && (
            <div className="max-w-lg mx-auto mb-6 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-center gap-3">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm font-medium">{error}</p>
            </div>
        )}

        {appState === AppState.PROCESSING ? (
            <div className="flex flex-col items-center justify-center py-20 space-y-6">
                <div className="relative">
                    <div className="w-24 h-24 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
                    <Loader2 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 text-blue-600 animate-pulse" />
                </div>
                <div className="text-center space-y-2">
                    <h2 className="text-xl font-bold text-slate-800">AI is aan het werk...</h2>
                    <p className="text-slate-500 max-w-xs mx-auto text-sm">Dit kan een paar minuten duren bij lange opnames. Sluit dit venster niet.</p>
                </div>
                <div className="w-full max-w-xs bg-slate-100 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-blue-600 h-full w-2/3 animate-progress"></div>
                </div>
            </div>
        ) : appState !== AppState.COMPLETED ? (
          <div className="flex flex-col items-center space-y-8">
            <div className="w-full max-w-lg space-y-2">
              <label className="text-sm font-medium text-slate-700 ml-1">Titel van de meeting</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bijv. Project X Status" className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none" />
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
      <footer className="py-6 text-center text-slate-400 text-xs">MeetingGenius Safe-Guard System &copy; {new Date().getFullYear()}</footer>
    </div>
  );
};

export default App;
