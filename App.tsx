
import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadTextToDrive, uploadAudioToDrive, disconnectDrive } from './services/driveService';
import { getActiveSession, recoverAudio, clearSession } from './services/storageService';
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  
  // Data State
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Audio State - We houden de chunks NIET meer in state om crashes te voorkomen
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  // Recovery State
  const [recoveryData, setRecoveryData] = useState<{blob: Blob, title: string} | null>(null);
  
  // Processing/Drive State
  const [isGeneratingMissing, setIsGeneratingMissing] = useState(false);
  const [isUploadedFile, setIsUploadedFile] = useState(false);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString().split(' ')[0]} ${msg}`]);
  }, []);

  // Check for recovery on mount
  useEffect(() => {
    const checkRecovery = async () => {
        const active = await getActiveSession();
        if (active) {
            const recovered = await recoverAudio();
            if (recovered) {
                setRecoveryData({ blob: recovered.blob, title: recovered.metadata.title });
                addLog("Onvoltooide opname gevonden!");
            }
        }
    };
    checkRecovery();
  }, [addLog]);

  // Initialize Drive
  useEffect(() => {
    initDrive((token) => {
        setIsDriveConnected(!!token);
        if (token) addLog("Google Drive verbonden");
    });
  }, [addLog]);

  const handleApplyRecovery = () => {
      if (!recoveryData) return;
      handleRecordingFinished(recoveryData.blob);
      setTitle(recoveryData.title);
      setAppState(AppState.PAUSED);
      setRecoveryData(null);
      addLog("Opname succesvol hersteld.");
  };

  const handleDiscardRecovery = async () => {
      await clearSession();
      setRecoveryData(null);
      addLog("Herstel-data verwijderd.");
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
      setIsUploadedFile(true);
      setAppState(AppState.PAUSED);
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
  };

  const saveAudioBackup = async (blob: Blob, currentTitle: string, isAuto = false) => {
    if (!isDriveConnected) return;
    const safeTitle = currentTitle.replace(/[^a-z0-9\s-]/gi, '_');
    const finalName = isAuto ? `BACKUP_${safeTitle}_${Date.now()}` : safeTitle;
    try {
        await uploadAudioToDrive(finalName, blob);
        addLog(isAuto ? "Automatische backup naar Drive geslaagd" : "Audio opgeslagen in Drive");
    } catch (err) {
        console.error(err);
        addLog("Backup naar Drive mislukt.");
    }
  };

  const handleManualAudioSave = async (isAuto = false) => {
      let blob = combinedBlob;
      // Als de blob niet in RAM staat (bijv. tijdens actieve opname), probeer hem uit IndexedDB te halen
      if (!blob && isAuto) {
          const recovered = await recoverAudio();
          if (recovered) blob = recovered.blob;
      }
      
      if (!blob) return;
      let currentTitle = title.trim() || `Meeting ${new Date().toLocaleString()}`;
      await saveAudioBackup(blob, currentTitle, isAuto);
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    let blob = combinedBlob;
    // Extra veiligheid: als de blob ontbreekt in state, haal hem uit IndexedDB
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
      addLog(`Verwerken met ${selectedModel}...`);
      const newData = await processMeetingAudio(blob, blob.type, mode, selectedModel, addLog);
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      
      // Save results to Drive
      if (isDriveConnected) {
          addLog("Resultaten opslaan in Drive...");
          await uploadTextToDrive(`${currentTitle}_notes`, newData.summary, 'Notes');
      }
      await clearSession(); // Alles is gelukt, we kunnen de lokale tijdelijke opslag legen
    } catch (apiError) {
      addLog(`Fout: ${apiError instanceof Error ? apiError.message : 'Verwerkingsfout'}`);
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
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header isDriveConnected={isDriveConnected} onConnectDrive={handleConnectDrive} onDisconnectDrive={disconnectDrive} selectedModel={selectedModel} onModelChange={setSelectedModel} />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8">
        
        {/* Recovery Alert */}
        {recoveryData && (
            <div className="max-w-lg mx-auto mb-8 bg-blue-600 text-white p-4 rounded-2xl shadow-lg flex items-center justify-between animate-in slide-in-from-top-4">
                <div className="flex items-center gap-3">
                    <AlertCircle className="w-6 h-6 shrink-0"/>
                    <div>
                        <p className="font-bold text-sm">Onverwachte crash gedetecteerd!</p>
                        <p className="text-xs opacity-90">We hebben een opname van "{recoveryData.title}" gevonden.</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button onClick={handleDiscardRecovery} className="p-2 hover:bg-red-500 rounded-lg transition-colors" title="Weggooien"><Trash2 className="w-4 h-4"/></button>
                    <button onClick={handleApplyRecovery} className="bg-white text-blue-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-100 transition-colors"><RotateCcw className="w-3.5 h-3.5"/> Herstel</button>
                </div>
            </div>
        )}

        {appState !== AppState.COMPLETED ? (
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
          <Results data={meetingData} title={title} onReset={handleDiscard} onGenerateMissing={handleProcessAudio} isProcessingMissing={isGeneratingMissing} onSaveAudio={handleManualAudioSave} />
        )}
      </main>
      <footer className="py-6 text-center text-slate-400 text-xs">MeetingGenius Safe-Guard System &copy; {new Date().getFullYear()}</footer>
    </div>
  );
};

export default App;
