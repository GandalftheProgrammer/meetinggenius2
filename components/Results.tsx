
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileText, ListChecks, ArrowLeft, FileAudio, Download, Eye } from 'lucide-react';
import { MeetingData, ProcessingMode } from '../types';

interface ResultsProps {
  data: MeetingData;
  title: string;
  onReset: () => void;
  onGenerateMissing: (mode: ProcessingMode) => void;
  isProcessingMissing: boolean;
  isDriveConnected: boolean;
  onConnectDrive: () => void;
  audioBlob: Blob | null;
  initialMode?: ProcessingMode;
}

const Results: React.FC<ResultsProps> = ({ 
  data, 
  title, 
  onReset, 
  audioBlob,
  initialMode = 'NOTES_ONLY'
}) => {
  // Track visibility of each column
  const [showNotes, setShowNotes] = useState(initialMode !== 'TRANSCRIPT_ONLY');
  const [showTranscript, setShowTranscript] = useState(initialMode !== 'NOTES_ONLY');

  const hasNotes = data.summary && data.summary.length > 0;
  const hasTranscript = data.transcription && data.transcription.length > 0;

  const notesMarkdown = `
# Meeting Notes: ${title}

## Summary
${data.summary}

## Conclusions
${data.conclusions.map(d => `- ${d}`).join('\n')}

## Action Items
${data.actionItems.map(item => `- [ ] ${item}`).join('\n')}
  `.trim();

  const transcriptMarkdown = `# Transcript: ${title}\n\n${data.transcription}`;

  const downloadBlob = (blob: Blob, suffix: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const extension = blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    link.download = `${title.replace(/\s+/g, '_')}_${suffix}.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadAsDoc = (markdown: string, suffix: string) => {
    // Basic markdown to minimal HTML for Word compatibility
    const htmlBody = markdown
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/- \[ \] (.*$)/gm, '<li>☐ $1</li>')
      .replace(/- (.*$)/gm, '<li>$1</li>')
      .replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>')
      .split('\n').join('<br>');

    const htmlContent = `<html><body style="font-family:Arial">${htmlBody}</body></html>`;
    const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/\s+/g, '_')}_${suffix}.doc`;
    link.click();
  };

  const renderRevealButton = (type: 'notes' | 'transcript') => (
    <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 p-8 border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/50">
      <div className="p-3 bg-white rounded-full shadow-sm">
         {type === 'notes' ? <ListChecks className="w-6 h-6 text-slate-300" /> : <FileText className="w-6 h-6 text-slate-300" />}
      </div>
      <div className="text-center">
        <p className="text-slate-600 font-medium mb-3">
          {type === 'notes' ? "Summary is ready" : "Transcript is ready"}
        </p>
        <button 
          onClick={() => type === 'notes' ? setShowNotes(true) : setShowTranscript(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg text-sm font-semibold shadow-sm"
        >
          <Eye className="w-4 h-4" />
          Reveal {type === 'notes' ? "Summary" : "Transcript"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-6xl mx-auto animate-in fade-in slide-in-from-bottom-8 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <button onClick={onReset} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors text-sm font-medium"><ArrowLeft className="w-4 h-4" />Back to record</button>
        <div className="flex flex-wrap items-center gap-2">
           {audioBlob && <button onClick={() => downloadBlob(audioBlob, 'audio')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><FileAudio className="w-4 h-4" />Audio</button>}
           {hasNotes && <button onClick={() => downloadAsDoc(notesMarkdown, 'notes')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><Download className="w-4 h-4" />Notes</button>}
           {hasTranscript && <button onClick={() => downloadAsDoc(transcriptMarkdown, 'transcript')} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-semibold transition-all shadow-sm"><Download className="w-4 h-4" />Transcript</button>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[calc(100vh-250px)] min-h-[500px]">
        {/* NOTES COLUMN */}
        <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-blue-500" />
            <h2 className="font-bold text-slate-800">Structured Notes</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {showNotes ? (
              hasNotes ? <div className="prose prose-slate prose-sm max-w-none"><ReactMarkdown>{notesMarkdown}</ReactMarkdown></div> : <p className="text-slate-400 italic">No notes data...</p>
            ) : renderRevealButton('notes')}
          </div>
        </div>

        {/* TRANSCRIPT COLUMN */}
        <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <FileText className="w-5 h-5 text-purple-500" />
            <h2 className="font-bold text-slate-800">Full Transcription</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {showTranscript ? (
              hasTranscript ? <div className="prose prose-slate prose-sm max-w-none"><ReactMarkdown>{data.transcription}</ReactMarkdown></div> : <p className="text-slate-400 italic">No transcript data...</p>
            ) : renderRevealButton('transcript')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Results;
