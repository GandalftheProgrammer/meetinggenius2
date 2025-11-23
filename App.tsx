
import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadTextToDrive, uploadAudioToDrive, disconnectDrive } from './services/driveService';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  
  // Data State
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Audio State
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  // Processing State
  const [isGeneratingMissing, setIsGeneratingMissing] = useState(false);
  
  // Drive State
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  
  // Logs
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString().split(' ')[0]} ${msg}`]);
  };

  // Initialize Drive on mount
  useEffect(() => {
    initDrive((token) => {
        if (token) {
            setIsDriveConnected(true);
            addLog("Google Drive connected automatically");
        }
    });
  }, []);

  // Handle user clicking "Connect Drive"
  const handleConnectDrive = () => {
      const storedName = localStorage.getItem('drive_folder_name');
      
      // If we already have a folder name stored, skip the prompt and just reconnect auth
      if (storedName) {
          connectToDrive();
      } else {
          // First time connection: Ask for folder
          const folderName = prompt("Choose a Google Drive folder name for your meeting data (Main Folder):", "MeetingGenius");
          if (folderName) {
              localStorage.setItem('drive_folder_name', folderName);
              connectToDrive();
          }
      }
  };

  const handleDisconnectDrive = () => {
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Google Drive disconnected");
  };

  // Whenever chunks update, rebuild the combined blob for preview
  useEffect(() => {
    if (audioChunks.length > 0) {
      const mimeType = audioChunks[0].type || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });
      setCombinedBlob(blob);
      
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      
      return () => URL.revokeObjectURL(url);
    } else {
      setCombinedBlob(null);
      setAudioUrl(null);
    }
  }, [audioChunks]);

  const handleChunkReady = (chunk: Blob) => {
    setAudioChunks(prev => [...prev, chunk]);
    addLog(`Chunk received: ${(chunk.size / 1024).toFixed(1)}KB`);
  };

  const handleRecordingChange = (isRecording: boolean) => {
    if (isRecording) {
      if (appState !== AppState.RECORDING) setAppState(AppState.RECORDING);
    } else {
       if (appState === AppState.RECORDING) {
         setAppState(AppState.PAUSED);
       }
    }
  };

  // Helper to save Audio to Drive (Safety Backup)
  const saveAudioBackup = async (blob: Blob, currentTitle: string) => {
    if (!isDriveConnected) return;
    const safeTitle = currentTitle.replace(/[^a-z0-9]/gi, '_');
    try {
        addLog("Backing up audio to Drive (/Audio)...");
        const result = await uploadAudioToDrive(safeTitle, blob);
        if (result.webViewLink) addLog(`Audio backed up: ${result.webViewLink}`);
    } catch (err) {
        console.error("Audio backup error", err);
        addLog("Warning: Audio backup to Drive failed.");
    }
  };

  // Manual Save Trigger (Passed to Results component)
  const handleManualAudioSave = async () => {
      if (!combinedBlob || !isDriveConnected) {
          if (!isDriveConnected) {
              // Try to connect if user clicks save but isn't connected
              handleConnectDrive();
              return; // User has to click again after connection
          }
          return;
      }
      let currentTitle = title.trim() || `Meeting ${new Date().toLocaleDateString()}`;
      await saveAudioBackup(combinedBlob, currentTitle);
  };

  // Helper to save Notes/Transcript to Drive
  const saveResultsToDrive = async (data: MeetingData, currentTitle: string) => {
    if (!isDriveConnected) return;
    
    const safeTitle = currentTitle.replace(/[^a-z0-9]/gi, '_');
    
    try {
        addLog("Saving results to Google Drive...");
        
        // Upload Notes if they exist
        if (data.summary) {
            const notesContent = `# Meeting Notes: ${currentTitle}\n\n## Summary\n${data.summary}\n\n## Conclusions & Insights\n${data.conclusions.map(d => `- ${d}`).join('\n')}\n\n## Action Items\n${data.actionItems.map(i => `- [ ] ${i}`).join('\n')}`;
            const result = await uploadTextToDrive(`${safeTitle}_notes.md`, notesContent, 'Notes');
            if (result.webViewLink) addLog(`Notes saved: ${result.webViewLink}`);
        }

        // Upload Transcript if it exists
        if (data.transcription) {
            const transcriptContent = `# Transcription: ${currentTitle}\n\n${data.transcription}`;
            const result = await uploadTextToDrive(`${safeTitle}_transcript.md`, transcriptContent, 'Transcripts');
            if (result.webViewLink) addLog(`Transcript saved: ${result.webViewLink}`);
        }
    } catch (err) {
        console.error("Drive upload error", err);
        addLog("Failed to save results to Drive.");
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob) return;

    let currentTitle = title.trim();
    if (!currentTitle) {
      currentTitle = `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
      setTitle(currentTitle);
    }

    // Visual state updates
    if (appState === AppState.COMPLETED) {
      setIsGeneratingMissing(true);
    } else {
      setAppState(AppState.PROCESSING);
      // Trigger Audio Backup immediately when processing starts (Fire & Forget)
      saveAudioBackup(combinedBlob, currentTitle);
    }
    
    try {
      addLog(`Processing Mode: ${mode}`);
      const mimeType = combinedBlob.type || 'audio/webm';
        
      const newData = await processMeetingAudio(combinedBlob, mimeType, mode, addLog);
      addLog("Success! Response received.");

      let updatedData: MeetingData;

      if (meetingData) {
        updatedData = {
            ...meetingData,
            transcription: newData.transcription || meetingData.transcription,
            summary: newData.summary || meetingData.summary,
            conclusions: newData.conclusions.length > 0 ? newData.conclusions : meetingData.conclusions,
            actionItems: newData.actionItems.length > 0 ? newData.actionItems : meetingData.actionItems
        };
      } else {
        updatedData = newData;
      }
      
      setMeetingData(updatedData);
      setAppState(AppState.COMPLETED);

      // AUTO SAVE RESULTS TO DRIVE
      await saveResultsToDrive(updatedData, currentTitle);

    } catch (apiError) {
      console.error(apiError);
      addLog(`Error: ${apiError instanceof Error ? apiError.message : 'Unknown API error'}`);
      setError("Failed to process audio. See logs.");
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
    setIsGeneratingMissing(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        onConnectDrive={handleConnectDrive} 
        onDisconnectDrive={handleDisconnectDrive}
      />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
        
        {error && (
          <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl text-center text-sm flex items-center justify-center gap-2">
            <span className="font-bold">Error:</span> {error}
          </div>
        )}

        {appState !== AppState.COMPLETED && (
          <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
            
            {appState === AppState.IDLE && !audioUrl && (
              <div className="text-center space-y-2 mb-4">
                <h2 className="text-3xl font-bold text-slate-800">Capture your meeting</h2>
                <p className="text-slate-500">Record audio to get instant summaries and action items.</p>
              </div>
            )}

            <div className="w-full max-w-lg space-y-2">
              <label htmlFor="title" className="block text-sm font-medium text-slate-700 ml-1">
                Meeting Title
              </label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Q4 Marketing Strategy"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none disabled:bg-slate-100 disabled:text-slate-400"
                disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
              />
            </div>

            <Recorder 
              appState={appState}
              onChunkReady={handleChunkReady}
              onProcessAudio={handleProcessAudio}
              onDiscard={handleDiscard}
              onRecordingChange={handleRecordingChange}
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
            onSaveAudio={isDriveConnected ? handleManualAudioSave : undefined}
          />
        )}

      </main>

      <footer className="py-6 text-center text-slate-400 text-sm">
        &copy; {new Date().getFullYear()} MeetingGenius. Built with Gemini 3 & React.
      </footer>
    </div>
  );
};

export default App;
