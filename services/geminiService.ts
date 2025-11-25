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

    // 2. Proxied Chunk Upload (Browser -> Netlify -> Google)
    // We use 3MB chunks to ensure Base64 payload (< 4.5MB) fits within Netlify/AWS Lambda 6MB limit.
    // Google requires chunks to be multiples of 256KB (3MB = 12 * 256KB, so it's valid).
    const CHUNK_SIZE = 3 * 1024 * 1024; 
    let offset = 0;
    let fileUri: string | null = null;
    
    log("Step 2: Starting Proxied Upload (3MB chunks)...");
    
    // Loop through chunks
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        const isLastChunk = offset + chunkBlob.size >= audioBlob.size;
        
        log(`Uploading chunk at offset ${(offset / 1024 / 1024).toFixed(2)}MB...${isLastChunk ? ' (Final)' : ''}`);

        // Convert Blob to Base64 for JSON transport
        const base64Data = await blobToBase64(chunkBlob);

        let attempt = 0;
        let uploaded = false;

        // Retry loop for robustness
        while (attempt < 3 && !uploaded) {
            try {
                attempt++;
                
                // Call the Proxy (Netlify Function) instead of Google directly
                const chunkResp = await fetch('/.netlify/functions/gemini', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'upload_chunk',
                        uploadUrl,
                        chunkData: base64Data, // Base64 string
                        offset: offset.toString(),
                        isLastChunk
                    })
                });
                
                if (!chunkResp.ok) {
                     const err = await chunkResp.text();
                     throw new Error(`Proxy Upload Failed [${chunkResp.status}]: ${err}`);
                }
                
                // If we finalized, we get the file URI in the response from the backend
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

// Helper to efficiently convert Blob to Base64
async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            // Remove the data URL prefix (e.g. "data:audio/webm;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

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