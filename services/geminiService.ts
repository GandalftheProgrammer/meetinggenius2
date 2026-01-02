
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

export const processMeetingAudio = async (
  audioBlob: Blob, 
  defaultMimeType: string, 
  mode: ProcessingMode = 'ALL',
  model: GeminiModel,
  onLog?: (msg: string) => void
): Promise<MeetingData> => {
  const log = (msg: string) => {
      console.log(msg);
      if (onLog) onLog(msg);
  };

  try {
    if (audioBlob.size < 2000) {
        throw new Error("De opname bevat te weinig geluid. Praat wat meer of controleer je microfoon.");
    }

    const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    log(`Start verwerking. Grootte: ${(totalBytes / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // --- STEP 1: CHUNKED UPLOAD ---
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
    let offset = 0;
    let chunkIndex = 0;

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);

        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });

        if (!uploadResp.ok) throw new Error(`Upload mislukt bij chunk ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    log(`Upload voltooid (${chunkIndex} chunks). Server verwerking gestart...`);

    // --- STEP 2: TRIGGER BACKGROUND JOB ---
    const startResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode, model, fileSize: totalBytes })
    });

    if (startResp.status !== 202 && !startResp.ok) throw new Error("Achtergrondtaak kon niet worden gestart.");

    // --- STEP 3: POLLING ---
    let attempts = 0;
    const MAX_ATTEMPTS = 200; 
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000)); 
        
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.ok) {
            const data = await pollResp.json();
            
            if (data.status === 'COMPLETED') {
                log("Verwerking voltooid!");
                const result = parseResponse(data.result || "{}", mode);
                
                if (mode === 'TRANSCRIPT_ONLY' && !result.transcription) throw new Error("Geen transcriptie gegenereerd.");
                if (mode === 'NOTES_ONLY' && !result.summary) throw new Error("Geen samenvatting gegenereerd.");
                
                return result;
            } 
            else if (data.status === 'ERROR') {
                throw new Error(data.error || "Onbekende fout in AI-verwerking.");
            }
        }
    }

    throw new Error("De verwerking duurt te lang. Controleer je internetverbinding.");

  } catch (error) {
    console.error("Gemini Service Error:", error);
    throw error;
  }
};

function getMimeTypeFromBlob(blob: Blob, defaultType: string): string {
    const type = blob.type.toLowerCase();
    if (type.includes('webm')) return 'audio/webm';
    if (type.includes('mp4')) return 'audio/mp4';
    if (type.includes('mpeg')) return 'audio/mpeg';
    if (type.includes('wav')) return 'audio/wav';
    if (type.includes('ogg')) return 'audio/ogg';
    
    if ('name' in blob) {
        const name = (blob as File).name.toLowerCase();
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.m4a')) return 'audio/mp4';
        if (name.endsWith('.webm')) return 'audio/webm';
    }
    return defaultType || 'audio/webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    let transcription = "";
    let summary = "";
    let conclusions: string[] = [];
    let actionItems: string[] = [];

    const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        const rawData = JSON.parse(cleanText);
        transcription = rawData.transcription || "";
        summary = rawData.summary || "";
        conclusions = rawData.conclusions || rawData.decisions || [];
        actionItems = rawData.actionItems || [];
    } catch (e) {
        const extractField = (key: string) => {
             const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 's');
             const match = cleanText.match(regex);
             return match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
        };
        transcription = extractField('transcription') || "";
        summary = extractField('summary') || "";
    }

    if (mode === 'TRANSCRIPT_ONLY') {
        summary = ""; conclusions = []; actionItems = [];
    } else if (mode === 'NOTES_ONLY') {
        transcription = "";
    }

    return { transcription, summary, conclusions, actionItems };
}
