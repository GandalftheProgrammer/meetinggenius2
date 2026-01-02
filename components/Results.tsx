
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileText, ListChecks, ArrowLeft, Loader2, PlusCircle, FileAudio, CheckCircle, Download } from 'lucide-react';
import { MeetingData, ProcessingMode } from '../types';

interface ResultsProps {
  data: MeetingData;
  title: string;
  onReset: () => void;
  onGenerateMissing: (mode: ProcessingMode) => void;
  isProcessingMissing: boolean;
  isDriveConnected: boolean;
  onConnectDrive: () => void;
  onSaveAudio?: () => Promise<void>;
}

const Results: React.FC<ResultsProps> = ({ 
  data, 
  title, 
  onReset, 
  onGenerateMissing,
  isProcessingMissing,
  isDriveConnected,
  onConnectDrive,
  onSaveAudio
}) => {
  const [activeTab, setActiveTab] = useState<'notes' | 'transcription'>('notes');
  const [isAudioSaving, setIsAudioSaving] = useState(false);
  const [audioSaved, setAudioSaved] = useState(false);

  const hasNotes = data.summary && data.summary.length > 0;
  const hasTranscript = data.transcription && data.transcription.length > 0;

  const getNotesMarkdown = () => {
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

  const notesMarkdown = getNotesMarkdown();
  const transcriptionMarkdown = `# Transcription: ${title}\n\n${data.transcription}`;

  const downloadAsDoc = (markdown: string, suffix: string) => {
    const htmlBody = markdown
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/- \[ \] (.*$)/gm, '<li>☐ $1</li>')
      .replace(/- (.*$)/gm, '<li>$1</li>')
      .replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>')
      .split('\n')
      .map(line => {
        const t = line.trim();
        if (!t) return '';
        if (t.startsWith('<h') || t.startsWith('<ul') || t.startsWith('<li')) return line;
        return `<p>${line}</p>`;
      })
      .join('');

    const htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head><meta charset='utf-8'><title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.4; color: #333; padding: 40px; }
        h1 { color: #1e293b; font-size: 24pt; margin: 0 0 12pt 0; font-weight: bold; }
        h2 { color: #334155; font-size: 18pt; margin: 16pt 0 6pt 0; border-bottom: 1px solid #eee; font-weight: bold; }
        h3 { color: #475569; font-size: 14pt; margin: 12pt 0 4pt 0; font-weight: bold; }
        p { margin: 0 0 8pt 0; }
        ul { margin: 0 0 10pt 0; padding-left: 20pt; }
        li { margin-bottom: 3pt; }
      </style>
      </head><body>${htmlBody}</body></html>
    `;

    const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/\s+/g, '_')}_${suffix}.doc`;
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
          alert("Opslaan audio mislukt");
      } finally {
          setIsAudioSaving(false);
      }
  };

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
            {isTranscript ? "Nog geen transcript" : "Nog geen samenvatting"}
          </p>
          <button 
            onClick={() => onGenerateMissing(mode)}
            disabled={isProcessingMissing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-blue-600 hover:text-blue-700 hover:border-blue-300 rounded-lg text-sm font-medium transition-all shadow-sm hover:shadow disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isProcessingMissing ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Genereren...</>
            ) : (
              <><PlusCircle className="w-4 h-4" />Genereer {isTranscript ? "Transcript" : "Summary"}</>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full max-w-6xl mx-auto animate-in fade-in slide-in-from-bottom-8 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <button 
          onClick={onReset}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          Nieuwe opname
        </button>
        
        <div className="flex flex-wrap items-center gap-2">
           {isDriveConnected && onSaveAudio && (
             <button
               onClick={handleManualAudioSave}
               disabled={isAudioSaving || audioSaved}
               className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium transition-colors shadow-sm ${
                   audioSaved ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
               }`}
             >
               {isAudioSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : audioSaved ? <CheckCircle className="w-4 h-4" /> : <FileAudio className="w-4 h-4" />}
               {audioSaved ? "Bewaard!" : "Audio"}
             </button>
           )}

           {hasNotes && (
             <button
               onClick={() => downloadAsDoc(notesMarkdown, 'notes')}
               className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-sm font-semibold transition-all shadow-sm"
             >
               <Download className="w-4 h-4" />
               Notes
             </button>
           )}
           
           {hasTranscript && (
             <button
               onClick={() => downloadAsDoc(transcriptionMarkdown, 'transcript')}
               className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-sm font-semibold transition-all shadow-sm"
             >
               <Download className="w-4 h-4" />
               Transcript
             </button>
           )}
        </div>
      </div>

      <div className="md:hidden flex p-1 bg-slate-200/50 rounded-xl mb-6">
        <button onClick={() => setActiveTab('notes')} className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all ${activeTab === 'notes' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Notes</button>
        <button onClick={() => setActiveTab('transcription')} className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all ${activeTab === 'transcription' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Transcript</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 h-[calc(100vh-220px)] min-h-[500px]">
        <div className={`flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ${activeTab === 'notes' ? 'block' : 'hidden md:flex'}`}>
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-blue-500" />
              <h2 className="font-semibold text-slate-800">Structured Notes</h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {hasNotes ? (
              <div className="prose prose-slate prose-sm max-w-none">
                <ReactMarkdown>{notesMarkdown}</ReactMarkdown>
              </div>
            ) : renderPlaceholder('notes')}
          </div>
        </div>

        <div className={`flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ${activeTab === 'transcription' ? 'block' : 'hidden md:flex'}`}>
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-purple-500" />
              <h2 className="font-semibold text-slate-800">Full Transcription</h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {hasTranscript ? (
              <div className="prose prose-slate prose-sm max-w-none">
                <ReactMarkdown>{data.transcription}</ReactMarkdown>
              </div>
            ) : renderPlaceholder('transcript')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Results;
