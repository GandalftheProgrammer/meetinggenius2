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
    // Determine MIME type strictly from file extension if available
    const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);
    
    log(`Starting Async SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // 1. Handshake (Get Upload URL + Granularity)
    log("Step 1: Requesting Upload URL...");
    const authResponse = await fetch('/.netlify/functions/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          action: 'authorize_upload', 
          mimeType, 
          fileSize: audioBlob.size.toString() 
      })
    });

    if (!authResponse.ok) {
        const err = await authResponse.text();
        throw new Error(`Handshake Failed: ${err}`);
    }
    const { uploadUrl, granularity } = await authResponse.json();
    log("Step 1: Upload URL received.");

    // 2. Direct Chunk Upload (Browser -> Google)
    // CRITICAL: We use Direct Upload because the API requires 8MB granularity which exceeds Netlify Function limits (6MB).
    // We use ArrayBuffer to prevent the browser from adding a Content-Type header, which causes 'Failed to fetch' CORS errors.
    
    // Use granularity from server or default to 8MB (Standard for GenAI File API)
    const CHUNK_SIZE = granularity ? parseInt(granularity) : 8 * 1024 * 1024;
    
    let offset = 0;
    let fileUri: string | null = null;
    
    log(`Step 2: Starting Direct Upload (${(CHUNK_SIZE / 1024 / 1024).toFixed(1)}MB chunks)...`);
    
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        const isLastChunk = offset + chunkBlob.size >= audioBlob.size;
        
        log(`Uploading chunk at offset ${(offset / 1024 / 1024).toFixed(2)}MB...${isLastChunk ? ' (Final)' : ''}`);

        // CRITICAL: Convert to ArrayBuffer to strip 'Content-Type' header. 
        // Sending Blob directly adds 'audio/webm' which can trigger CORS failures on Signed URLs.
        const chunkArrayBuffer = await chunkBlob.arrayBuffer();

        let attempt = 0;
        let uploaded = false;

        while (attempt < 3 && !uploaded) {
            try {
                attempt++;
                
                // Direct Upload to Google
                const chunkResp = await fetch(uploadUrl, {
                    method: 'POST', // The Resumable API usually accepts POST or PUT. POST is generally safer for headers.
                    headers: { 
                        'X-Goog-Upload-Command': isLastChunk ? 'upload, finalize' : 'upload',
                        'X-Goog-Upload-Offset': offset.toString()
                        // Note: We intentionally do NOT set Content-Length (browser sets it) 
                        // and do NOT set Content-Type (ArrayBuffer leaves it empty).
                    },
                    body: chunkArrayBuffer
                });
                
                if (!chunkResp.ok) {
                     const err = await chunkResp.text();
                     throw new Error(`Upload Failed [${chunkResp.status}]: ${err}`);
                }
                
                // If finalized, extract the file info
                if (isLastChunk) {
                    const result = await chunkResp.json();
                    if (result.file && result.file.uri) {
                        fileUri = result.file.uri;
                    } else if (result.uri) {
                        fileUri = result.uri;
                    } else {
                        console.warn("Finalize response missing URI, checking body:", result);
                    }
                }
                
                uploaded = true;

            } catch (e: any) {
                console.warn(`Upload attempt ${attempt} failed for offset ${offset}:`, e);
                if (attempt >= 3) {
                    throw new Error(`Failed to upload chunk at offset ${offset} after 3 attempts. Last error: ${e.message}`);
                }
                log(`Chunk upload failed (Attempt ${attempt}). Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        offset += CHUNK_SIZE;
    }

    if (!fileUri) {
         throw new Error("Upload process completed but no File URI was returned from Google.");
    }

    log(`File upload finalized. URI: ${fileUri}`);

    // 3. Start Background Job
    log(`Step 3: Queuing Background Job with model: ${model}...`);
    
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const startResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUri, mimeType, mode, jobId, model })
    });

    if (startResp.status !== 202 && !startResp.ok) {
        const errorText = await startResp.text();
        throw new Error(`Failed to start background job: ${errorText}`);
    }
    
    log(`Job started with ID: ${jobId}. Waiting for results...`);

    // 4. Poll for results
    let attempts = 0;
    const MAX_ATTEMPTS = 200; // 10 minutes max
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        
        if (attempts % 5 === 0) {
            log(`Checking status (Attempt ${attempts})...`);
        }

        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            if (data.status === 'COMPLETED' && data.result) {
                log("Job Completed! Result received.");
                return parseResponse(data.result, mode);
            } else if (data.status === 'ERROR') {
                throw new Error(`Background Processing Error: ${data.error}`);
            }
        } else if (pollResp.status !== 404) {
            log(`Polling error: ${pollResp.statusText}`);
        }
    }

    throw new Error("Timeout: Background job took too long to complete.");

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

function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    try {
        const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        
        if (firstBrace === -1 || lastBrace === -1) {
             return {
                 transcription: jsonText,
                 summary: "Raw text received (could not parse JSON)",
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