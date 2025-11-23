
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Download, FileText, ListChecks, ArrowLeft, Loader2, PlusCircle, FileAudio, CheckCircle } from 'lucide-react';
import { MeetingData, ProcessingMode } from '../types';

interface ResultsProps {
  data: MeetingData;
  title: string;
  onReset: () => void;
  onGenerateMissing: (mode: ProcessingMode) => void;
  isProcessingMissing: boolean;
  onSaveAudio?: () => void;
}

const Results: React.FC<ResultsProps> = ({ 
  data, 
  title, 
  onReset, 
  onGenerateMissing,
  isProcessingMissing,
  onSaveAudio
}) => {
  const [activeTab, setActiveTab] = useState<'notes' | 'transcription'>('notes');
  const [isAudioSaving, setIsAudioSaving] = useState(false);
  const [audioSaved, setAudioSaved] = useState(false);

  const hasNotes = data.summary && data.summary.length > 0;
  const hasTranscript = data.transcription && data.transcription.length > 0;

  // Helper to format the Structured Notes into Markdown for display/download
  const getFormattedNotesMarkdown = () => {
    if (!hasNotes) return "";
    return `
# Meeting Notes: ${title}

## Summary
${data.summary}

## Conclusions & Insights
${data.conclusions.map(d => `- ${d}`).join('\n')}

## Action Items
${data.actionItems.map(item => `- [ ] ${item}`).join('\n')}
    `.trim();
  };

  const notesMarkdown = getFormattedNotesMarkdown();
  const transcriptionMarkdown = `# Transcription: ${title}\n\n${data.transcription}`;

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleManualAudioSave = async () => {
      if (!onSaveAudio) return;
      setIsAudioSaving(true);
      try {
          await onSaveAudio();
          setAudioSaved(true);
          setTimeout(() => setAudioSaved(false), 3000);
      } catch (e) {
          console.error(e);
          alert("Failed to save audio to Drive");
      } finally {
          setIsAudioSaving(false);
      }
  };

  // Render a placeholder with a button if content is missing
  const renderPlaceholder = (type: 'notes' | 'transcript') => {
    const isTranscript = type === 'transcript';
    const mode = isTranscript ? 'TRANSCRIPT_ONLY' : 'NOTES_ONLY';
    
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 p-8 border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/50">
        <div className="p-3 bg-white rounded-full shadow-sm">
           {isTranscript ? <FileText className="w-6 h-6 text-slate-300" /> : <ListChecks className="w-6 h-6 text-slate-300" />}
        </div>
        <div className="text-center">
          <p className="text-slate-600 font-medium mb-1">
            {isTranscript ? "No Transcript Generated" : "No Summary Generated"}
          </p>
          <p className="text-slate-400 text-xs mb-4 max-w-xs">
            {isTranscript 
              ? "You only generated notes. Want the full text?" 
              : "You only generated the transcript. Want structured notes?"}
          </p>
          <button 
            onClick={() => onGenerateMissing(mode)}
            disabled={isProcessingMissing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-blue-600 hover:text-blue-700 hover:border-blue-300 rounded-lg text-sm font-medium transition-all shadow-sm hover:shadow disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isProcessingMissing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <PlusCircle className="w-4 h-4" />
                Generate {isTranscript ? "Transcript" : "Summary"}
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full max-w-6xl mx-auto animate-in fade-in slide-in-from-bottom-8 duration-500">
      
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <button 
          onClick={onReset}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          Start New Recording
        </button>
        
        <div className="flex flex-wrap items-center gap-2">
           
           {/* Manual Audio Save Button */}
           {onSaveAudio && (
             <button
               onClick={handleManualAudioSave}
               disabled={isAudioSaving || audioSaved}
               className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium transition-colors shadow-sm ${
                   audioSaved 
                   ? 'bg-green-50 border-green-200 text-green-700' 
                   : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
               }`}
               title="Manually save audio to Google Drive"
             >
               {isAudioSaving ? (
                 <Loader2 className="w-4 h-4 animate-spin" />
               ) : audioSaved ? (
                 <CheckCircle className="w-4 h-4" />
               ) : (
                 <FileAudio className="w-4 h-4" />
               )}
               {audioSaved ? "Saved!" : "Save Audio to Drive"}
             </button>
           )}

           {hasNotes && (
             <button
               onClick={() => downloadFile(notesMarkdown, `${title.replace(/\s+/g, '_')}_notes.md`)}
               className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm"
             >
               <Download className="w-4 h-4" />
               Download Notes
             </button>
           )}
           {hasTranscript && (
             <button
               onClick={() => downloadFile(transcriptionMarkdown, `${title.replace(/\s+/g, '_')}_transcript.md`)}
               className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm"
             >
               <Download className="w-4 h-4" />
               Download Transcript
             </button>
           )}
        </div>
      </div>

      {/* Mobile Tabs */}
      <div className="md:hidden flex p-1 bg-slate-200/50 rounded-xl mb-6">
        <button
          onClick={() => setActiveTab('notes')}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
            activeTab === 'notes' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Structured Notes
        </button>
        <button
          onClick={() => setActiveTab('transcription')}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
            activeTab === 'transcription' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Transcription
        </button>
      </div>

      {/* Content Area - Grid on Desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 h-[calc(100vh-220px)] min-h-[500px]">
        
        {/* Structured Notes Panel */}
        <div className={`flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ${
          activeTab === 'notes' ? 'block' : 'hidden md:flex'
        }`}>
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-blue-500" />
            <h2 className="font-semibold text-slate-800">Structured Notes</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {hasNotes ? (
              <div className="prose prose-slate prose-sm max-w-none prose-headings:text-slate-800 prose-p:text-slate-600 prose-li:text-slate-600">
                <ReactMarkdown>{notesMarkdown}</ReactMarkdown>
              </div>
            ) : (
              renderPlaceholder('notes')
            )}
          </div>
        </div>

        {/* Transcription Panel */}
        <div className={`flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ${
          activeTab === 'transcription' ? 'block' : 'hidden md:flex'
        }`}>
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <FileText className="w-5 h-5 text-purple-500" />
            <h2 className="font-semibold text-slate-800">Full Transcription</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {hasTranscript ? (
              <div className="prose prose-slate prose-sm max-w-none prose-headings:text-slate-800 prose-p:text-slate-600 prose-li:text-slate-600">
                <ReactMarkdown>{data.transcription}</ReactMarkdown>
              </div>
            ) : (
              renderPlaceholder('transcript')
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default Results;
