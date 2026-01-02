
import { GoogleGenAI } from "@google/genai";
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

const SYSTEM_INSTRUCTION = `You are an expert meeting secretary.
1. Analyze audio to detect the primary language.
2. All output MUST be in the DETECTED LANGUAGE.
3. Return a raw JSON object with: transcription, summary, conclusions (array), actionItems (array).`;

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

  if (process.env.API_KEY) {
      log("Initializing Gemini Client...");
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Audio = await blobToBase64(audioBlob);

      log("Sending audio to Gemini (Local Mode)...");
      try {
          const response = await ai.models.generateContent({
              model: model,
              contents: {
                  parts: [
                      { inlineData: { data: base64Audio, mimeType: mimeType } },
                      { text: "Generate full transcript and structured notes. Return JSON." }
                  ]
              },
              config: {
                  systemInstruction: SYSTEM_INSTRUCTION,
                  responseMimeType: "application/json"
              }
          });

          log("AI analysis successful.");
          return parseResponse(response.text || "{}", mode);
      } catch (e: any) {
          log(`Error: ${e.message}`);
          throw e;
      }
  }

  log("Starting multi-step upload process...");
  try {
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    const totalChunks = Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
    let offset = 0;
    let chunkIndex = 0;

    log(`Total size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    log(`Dividing into ${totalChunks} chunks for upload...`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);

        log(`Uploading chunk ${chunkIndex + 1}/${totalChunks} to cloud storage...`);

        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });

        if (!uploadResp.ok) throw new Error(`Upload failed at chunk ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    log("Cloud upload complete. Triggering background AI worker...");
    await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode: 'ALL', model, fileSize: totalBytes })
    });

    log("Background worker started. Waiting for Gemini to process audio...");
    let attempts = 0;
    while (attempts < 300) {
        attempts++;
        if (attempts % 4 === 0) log(`Gemini is still working... (Step ${attempts})`);
        
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            if (data.status === 'COMPLETED') {
                log("Processing complete! Fetching results...");
                return parseResponse(data.result, mode);
            }
            if (data.status === 'ERROR') {
                log(`Critical Failure: ${data.error}`);
                throw new Error(data.error);
            }
        }
    }
    throw new Error("Job timed out.");
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
    try {
        const rawData = JSON.parse(cleanText);
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            conclusions: rawData.conclusions || [],
            actionItems: rawData.actionItems || []
        };
    } catch (e) {
        return { transcription: "", summary: "Error parsing result", conclusions: [], actionItems: [] };
    }
}
