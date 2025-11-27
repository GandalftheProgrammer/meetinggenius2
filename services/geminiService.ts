
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
    const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    log(`Starting Safe Upload Flow. Blob size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // --- STEP 1: CHUNKED UPLOAD TO STORAGE (Netlify Blobs) ---
    // We split into 4MB chunks to strictly adhere to Netlify Function 6MB payload limit.
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
    let offset = 0;
    let chunkIndex = 0;

    log(`Step 1: Uploading to temporary storage in ${(UPLOAD_CHUNK_SIZE/1024/1024).toFixed(0)}MB chunks...`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        
        const progress = Math.round((chunkEnd / totalBytes) * 100);
        log(`Uploading chunk ${chunkIndex + 1}: ${offset}-${chunkEnd} (${progress}%)`);

        // Convert to Base64 to safely pass through JSON body
        const base64Data = await blobToBase64(chunkBlob);

        // Upload to Backend -> Netlify Blob
        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'upload_chunk', 
                jobId, 
                chunkIndex, 
                data: base64Data 
            })
        });

        if (!uploadResp.ok) {
            const err = await uploadResp.text();
            throw new Error(`Storage Upload Failed (Chunk ${chunkIndex}): ${err}`);
        }

        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    const totalChunks = chunkIndex;
    log(`Storage Upload Complete. ${totalChunks} chunks saved.`);

    // --- STEP 2: TRIGGER SERVER-SIDE PROCESSING ---
    // The background function will:
    // 1. Read chunks from storage
    // 2. Stitch them into 8MB buffers (Gemini Requirement)
    // 3. Upload to Gemini Server-to-Server (No CORS)
    
    log(`Step 2: Queuing Server-Side Processing with model: ${model}...`);
    
    const startResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            jobId, 
            totalChunks, 
            mimeType, 
            mode, 
            model,
            fileSize: totalBytes
        })
    });

    if (startResp.status !== 202 && !startResp.ok) {
        const errorText = await startResp.text();
        throw new Error(`Failed to start background job: ${errorText}`);
    }
    
    log(`Job started with ID: ${jobId}. Waiting for results...`);

    // --- STEP 3: POLL FOR RESULTS ---
    let attempts = 0;
    const MAX_ATTEMPTS = 300; // 15 minutes (300 * 3s)
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000)); 
        
        if (attempts % 5 === 0) log(`Checking status (Attempt ${attempts})...`);

        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            
            if (data.status === 'COMPLETED' && data.result) {
                log("Job Completed Successfully!");
                return parseResponse(data.result, mode);
            } 
            else if (data.status === 'ERROR') {
                // Try to make the error message cleaner
                let errMsg = data.error;
                try {
                    const jsonError = JSON.parse(errMsg);
                    if (jsonError.error && jsonError.error.message) {
                        errMsg = `API Error: ${jsonError.error.message} (Code: ${jsonError.error.code})`;
                    }
                } catch (e) {}
                
                throw new Error(`Processing Error: ${errMsg}`);
            }
            // If PROCESSING, continue loop
        }
    }

    throw new Error("Timeout: Background job took too long.");

  } catch (error) {
    console.error("Error in SaaS flow:", error);
    throw error;
  }
};

function getMimeTypeFromBlob(blob: Blob, defaultType: string): string {
    if ('name' in blob) {
        const name = (blob as File).name.toLowerCase();
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.m4a') || name.endsWith('.mp4')) return 'audio/mp4';
        if (name.endsWith('.aac')) return 'audio/aac';
        if (name.endsWith('.ogg')) return 'audio/ogg';
        if (name.endsWith('.flac')) return 'audio/flac';
        if (name.endsWith('.webm')) return 'audio/webm';
    }
    if (blob.type && blob.type !== 'application/octet-stream') {
        return blob.type;
    }
    return defaultType;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:audio/webm;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    try {
        const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        
        if (firstBrace === -1 || lastBrace === -1) {
             return {
                 transcription: jsonText,
                 summary: "Raw text received",
                 conclusions: [],
                 actionItems: []
             };
        }
        
        const jsonOnly = cleanText.substring(firstBrace, lastBrace + 1);
        const rawData = JSON.parse(jsonOnly);
        
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            conclusions: rawData.conclusions || rawData.decisions || [], 
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("Failed to parse inner JSON structure", e);
        return {
            transcription: jsonText, 
            summary: "Error parsing structured notes.",
            conclusions: [],
            actionItems: []
        };
    }
}
