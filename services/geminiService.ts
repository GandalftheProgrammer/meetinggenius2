
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
                if (typeof data.result === 'string') {
                    // Log snippet for debugging
                    console.log("[GeminiService] Response Snippet:", data.result.substring(0, 100));
                }
                return parseResponse(data.result, mode);
            } 
            else if (data.status === 'ERROR') {
                let errMsg = data.error || "Unknown Server Error";
                // Try to parse JSON errors
                try {
                    if (errMsg.startsWith('{')) {
                         const jsonError = JSON.parse(errMsg);
                         if (jsonError.error && jsonError.error.message) {
                             errMsg = `${jsonError.error.message} (Code: ${jsonError.error.code})`;
                         }
                    } else if (errMsg.trim().toLowerCase().startsWith('<!doctype html') || errMsg.includes('<html')) {
                        // Detect HTML error page (common with 401/403/500 from Google LBs)
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(errMsg, 'text/html');
                        const title = doc.querySelector('title')?.innerText || "HTML Error Page";
                        const body = doc.body?.innerText?.substring(0, 100).replace(/\n/g, ' ') || "";
                        errMsg = `Received HTML Error: "${title}" - ${body}`;
                    }
                } catch (e) {
                    // Keep original errMsg if parse fails
                }
                
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
    let transcription = "";
    let summary = "";
    let conclusions: string[] = [];
    let actionItems: string[] = [];
    let isError = false;

    // Pre-cleaning: Remove markdown code blocks
    const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        const rawData = JSON.parse(cleanText);
        
        transcription = rawData.transcription || "";
        summary = rawData.summary || "";
        conclusions = rawData.conclusions || rawData.decisions || [];
        actionItems = rawData.actionItems || [];

    } catch (e) {
        // JSON Parsing Failed (likely due to cut-off text or formatting issues)
        isError = true;

        // Fallback: Regex Extraction
        // Tries to extract content inside "key": "value", handling escaped quotes
        const extractField = (key: string) => {
             // Look for "key": "
             // Then capture everything until the next " that is NOT preceded by a \ (escaped)
             const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 's');
             const match = cleanText.match(regex);
             return match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
        };

        const regexTrans = extractField('transcription');
        const regexSum = extractField('summary');

        if (regexTrans) transcription = regexTrans;
        if (regexSum) summary = regexSum;

        // Final Fallback: If Regex failed and we are in single-mode, assumes raw text might be the content
        if (!transcription && !summary) {
            if (mode === 'TRANSCRIPT_ONLY') {
                // If it looks like JSON wrapper but failed parsing, strip the wrapper
                if (cleanText.trim().startsWith('{')) {
                     // Remove opening { "transcription": " (flexible whitespace)
                     let text = cleanText.replace(/^\s*{\s*"transcription"\s*:\s*"/, '');
                     // Remove trailing "} or "
                     text = text.replace(/"\s*}\s*$/, '').replace(/"\s*$/, '');
                     transcription = text;
                } else {
                     transcription = cleanText;
                }
                isError = false; 
            } else if (mode === 'NOTES_ONLY') {
                summary = cleanText;
                isError = false; 
            }
        }
    }

    // Force Cleanup based on Mode
    if (mode === 'TRANSCRIPT_ONLY') {
        summary = "";
        conclusions = [];
        actionItems = [];
    } else if (mode === 'NOTES_ONLY') {
        transcription = "";
    }
    
    return {
        transcription,
        summary,
        conclusions,
        actionItems,
    };
}
