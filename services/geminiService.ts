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
    // Determine MIME type strictly from file extension if available (fixes slow Google indexing)
    const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);
    
    log(`Starting Async SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // 1. Handshake (Get Upload URL via Backend to keep API Key safe)
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
    const { uploadUrl } = await authResponse.json();
    log("Step 1: Upload URL received.");

    // 2. Direct Chunk Upload (Browser -> Google)
    // We use 8MB chunks because Google API requires multiples of 256KB.
    const CHUNK_SIZE = 8 * 1024 * 1024; 
    let offset = 0;
    
    log("Step 2: Starting Direct Upload (8MB chunks)...");
    
    // Loop through chunks and upload them using 'upload' command
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        // CRITICAL: Convert to ArrayBuffer to prevent browser from adding Content-Type header
        // which can cause CORS or Signature errors on the signed URL.
        const chunkBuffer = await chunkBlob.arrayBuffer();
        
        log(`Uploading chunk at offset ${(offset / 1024 / 1024).toFixed(2)}MB...`);

        let attempt = 0;
        let uploaded = false;

        // Retry loop for robustness
        while (attempt < 3 && !uploaded) {
            try {
                attempt++;
                
                const chunkResp = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: {
                        'X-Goog-Upload-Offset': offset.toString(),
                        'X-Goog-Upload-Command': 'upload', 
                    },
                    body: chunkBuffer 
                });
                
                if (!chunkResp.ok) {
                     const err = await chunkResp.text();
                     throw new Error(`Chunk Upload Failed [${chunkResp.status}]: ${err}`);
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

    // 3. Finalize Upload
    // We send a separate finalize command. This splits the heavy data upload from the 
    // response processing, reducing the chance of "Failed to fetch" on the last step.
    log("Step 2b: Finalizing upload...");
    let fileUri: string | null = null;
    let finalizeAttempt = 0;

    while (finalizeAttempt < 3 && !fileUri) {
        try {
            finalizeAttempt++;
            const finalizeResp = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'X-Goog-Upload-Offset': audioBlob.size.toString(),
                    'X-Goog-Upload-Command': 'finalize',
                },
                body: '' // Empty body
            });

            if (!finalizeResp.ok) {
                 const err = await finalizeResp.text();
                 throw new Error(`Finalize Failed [${finalizeResp.status}]: ${err}`);
            }

            const result = await finalizeResp.json();
            if (result.file && result.file.uri) {
                fileUri = result.file.uri;
            } else if (result.uri) {
                fileUri = result.uri;
            } else {
                throw new Error("No File URI in finalize response");
            }

        } catch (e: any) {
             console.warn(`Finalize attempt ${finalizeAttempt} failed:`, e);
             if (finalizeAttempt >= 3) {
                 throw new Error(`Failed to finalize upload. Last error: ${e.message}`);
             }
             log(`Finalize failed (Attempt ${finalizeAttempt}). Retrying in 2s...`);
             await new Promise(r => setTimeout(r, 2000));
        }
    }

    log(`File upload finalized. URI: ${fileUri}`);

    // 4. Start Background Job
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

    // 5. Poll for Results
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
