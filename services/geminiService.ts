
import { GoogleGenAI } from "@google/genai";
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

/**
 * Dit bestand ondersteunt nu twee modi:
 * 1. Sandbox Mode (Direct via @google/genai SDK als process.env.API_KEY aanwezig is)
 * 2. Production Mode (Via Netlify Backend functies voor chunked uploads)
 */

const SYSTEM_INSTRUCTION = `You are an expert meeting secretary.
1. CRITICAL: Analyze the audio to detect the primary spoken language.
2. CRITICAL: All output (transcription, summary, conclusions, action items) MUST be written in the DETECTED LANGUAGE.
3. If the audio is silent or contains only noise, return a valid JSON with empty fields.
4. Action items must be EXPLICIT tasks only assigned to specific people if mentioned.
5. The Summary must be DETAILED and COMPREHENSIVE.
6. Conclusions & Insights should be extensive, capturing all decisions.

STRICT OUTPUT FORMAT:
You MUST return a raw JSON object with the following schema:
{
  "transcription": "...",
  "summary": "...",
  "conclusions": ["..."],
  "actionItems": ["..."]
}`;

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

  const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);

  // --- CHECK VOOR SANDBOX MODUS ---
  // In AI Studio is process.env.API_KEY vaak direct beschikbaar.
  if (process.env.API_KEY) {
      log("Sandbox gedetecteerd: Gebruik directe client-side SDK...");
      
      if (audioBlob.size > 20 * 1024 * 1024) {
          log("Waarschuwing: Bestand is groot (>20MB). Client-side processing kan traag zijn of falen in de sandbox.");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Audio = await blobToBase64(audioBlob);

      let taskInstruction = "";
      if (mode === 'TRANSCRIPT_ONLY') taskInstruction = "Transcribe the audio verbatim in the spoken language. Leave summary/conclusions/actionItems empty.";
      else if (mode === 'NOTES_ONLY') taskInstruction = "Create detailed structured notes in the spoken language. Leave transcription empty.";
      else taskInstruction = "Transcribe verbatim AND create detailed notes in the spoken language.";

      try {
          const response = await ai.models.generateContent({
              model: model,
              contents: [{
                  parts: [
                      { inlineData: { data: base64Audio, mimeType: mimeType } },
                      { text: taskInstruction }
                  ]
              }],
              config: {
                  systemInstruction: SYSTEM_INSTRUCTION,
                  responseMimeType: "application/json"
              }
          });

          return parseResponse(response.text || "{}", mode);
      } catch (e: any) {
          log(`SDK Error: ${e.message}`);
          throw e;
      }
  }

  // --- BACKEND FALLBACK (NETLIFY) ---
  log("Geen lokale API-sleutel: Gebruik Netlify backend flow...");
  try {
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Step 1: Chunked Upload
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
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

        if (!uploadResp.ok) throw new Error(`Upload Failed at chunk ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    // Step 2: Trigger Processing
    await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode, model, fileSize: totalBytes })
    });

    // Step 3: Polling
    let attempts = 0;
    while (attempts < 300) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            if (data.status === 'COMPLETED') return parseResponse(data.result, mode);
            if (data.status === 'ERROR') throw new Error(data.error);
        }
    }
    throw new Error("Polling Timeout");
  } catch (error) {
    throw error;
  }
};

function getMimeTypeFromBlob(blob: Blob, defaultType: string): string {
    if ('name' in blob) {
        const name = (blob as File).name.toLowerCase();
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.m4a')) return 'audio/mp4';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.webm')) return 'audio/webm';
    }
    return blob.type || defaultType;
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
    const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
    let transcription = "";
    let summary = "";
    let conclusions: string[] = [];
    let actionItems: string[] = [];

    try {
        const rawData = JSON.parse(cleanText);
        transcription = rawData.transcription || "";
        summary = rawData.summary || "";
        conclusions = rawData.conclusions || rawData.decisions || [];
        actionItems = rawData.actionItems || [];
    } catch (e) {
        if (mode === 'TRANSCRIPT_ONLY') transcription = cleanText;
        else summary = cleanText;
    }

    if (mode === 'TRANSCRIPT_ONLY') { summary = ""; conclusions = []; actionItems = []; }
    else if (mode === 'NOTES_ONLY') { transcription = ""; }

    return { transcription, summary, conclusions, actionItems };
}
