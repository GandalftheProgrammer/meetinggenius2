
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

    // 2. Direct Upload (Browser -> Google)
    // STRATEGY: We want to upload in as few chunks as possible to avoid "last chunk" network errors.
    // However, we MUST respect the granularity (usually 8MB) for any chunk that isn't the final one.
    
    // Default granularity is 256KB if not specified, but Google usually mandates 8MB for large files.
    const serverGranularity = granularity ? parseInt(granularity) : 256 * 1024;
    
    // Target a large chunk size (e.g., 64MB) to try and upload most files in ONE request.
    // This effectively mimics "unchunked" uploads for files < 64MB, which is much more stable.
    const TARGET_CHUNK_SIZE = 64 * 1024 * 1024; 
    
    // Adjust target to be a multiple of the server's granularity
    const CHUNK_SIZE = Math.ceil(TARGET_CHUNK_SIZE / serverGranularity) * serverGranularity;

    let offset = 0;
    let fileUri: string | null = null;
    
    log(`Step 2: Starting Direct Upload...`);
    log(`Strategy: ${CHUNK_SIZE / 1024 / 1024}MB chunks (Granularity: ${serverGranularity / 1024 / 1024}MB)`);
    
    while (offset < audioBlob.size) {
        // Calculate chunk boundaries
        const sliceEnd = Math.min(offset + CHUNK_SIZE, audioBlob.size);
        const chunkBlob = audioBlob.slice(offset, sliceEnd);
        const isLastChunk = sliceEnd >= audioBlob.size;
        
        log(`Uploading chunk: ${(offset / 1024 / 1024).toFixed(2)}MB - ${(sliceEnd / 1024 / 1024).toFixed(2)}MB ${isLastChunk ? '(Final)' : ''}`);

        // CRITICAL: Convert to ArrayBuffer to strip 'Content-Type' header. 
        // Sending Blob directly adds 'audio/webm' which can trigger CORS failures on Signed URLs.
        const chunkArrayBuffer = await chunkBlob.arrayBuffer();

        let attempt = 0;
        let uploaded = false;

        while (attempt < 3 && !uploaded) {
            try {
                attempt++;
                
                // Using PUT is often more standard for binary payload uploads than POST
                const chunkResp = await fetch(uploadUrl, {
                    method: 'PUT', 
                    headers: { 
                        'X-Goog-Upload-Command': isLastChunk ? 'upload, finalize' : 'upload',
                        'X-Goog-Upload-Offset': offset.toString()
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
                        // Fallback: If JSON is returned but URI is missing, logging it might help debug
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
