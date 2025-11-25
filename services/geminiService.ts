
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
    
    log(`[DEBUG] Init - Blob Size: ${audioBlob.size} bytes`);
    log(`[DEBUG] Init - Blob Type: ${audioBlob.type}`);
    log(`[DEBUG] Init - Computed MimeType: ${mimeType}`);

    // 1. Handshake (Get Upload URL)
    log("Step 1: Requesting Upload URL via Netlify...");
    const authResponse = await fetch('/.netlify/functions/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          action: 'authorize_upload', 
          mimeType, 
          fileSize: audioBlob.size.toString() 
      })
    });

    log(`[DEBUG] Handshake Status: ${authResponse.status} ${authResponse.statusText}`);

    if (!authResponse.ok) {
        const err = await authResponse.text();
        throw new Error(`Handshake Failed: ${err}`);
    }
    const { uploadUrl } = await authResponse.json();
    
    if (!uploadUrl) throw new Error("Handshake succeeded but no uploadUrl returned.");
    log(`[DEBUG] Handshake Success. URL received (len: ${uploadUrl.length}).`);

    // 2. Direct Upload (Browser -> Google) via XMLHttpRequest
    // STRATEGY: Single PUT request with Content-Range.
    // We use XHR instead of fetch because 'Failed to fetch' is opaque and often masks 
    // network timeouts or CORS preflight failures that XHR handles more robustly.
    
    log(`Step 2: Starting Direct Upload (XHR)...`);
    
    // Convert to ArrayBuffer to ensure clean transmission without browser auto-headers
    log("[DEBUG] Converting Blob to ArrayBuffer...");
    const arrayBuffer = await audioBlob.arrayBuffer();
    log(`[DEBUG] ArrayBuffer created. ByteLength: ${arrayBuffer.byteLength}`);
    
    let fileUri: string | null = null;
    let attempt = 0;
    let uploaded = false;

    while (attempt < 3 && !uploaded) {
        attempt++;
        log(`[DEBUG] --- Upload Attempt ${attempt} ---`);
        try {
            const response = await new Promise<any>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                
                // Event Listeners for Debugging
                xhr.addEventListener('loadstart', () => log(`[DEBUG] XHR: LoadStart`));
                xhr.addEventListener('error', (e) => log(`[DEBUG] XHR: Error Event detected`));
                xhr.addEventListener('abort', () => log(`[DEBUG] XHR: Abort`));
                xhr.addEventListener('timeout', () => log(`[DEBUG] XHR: Timeout`));
                
                xhr.upload.addEventListener('loadstart', () => log(`[DEBUG] XHR Upload: LoadStart`));
                xhr.upload.addEventListener('error', () => log(`[DEBUG] XHR Upload: Error`));
                xhr.upload.addEventListener('progress', (e) => {
                     if (e.lengthComputable) {
                         const p = Math.floor((e.loaded / e.total) * 100);
                         if (p % 10 === 0 || p === 100) {
                             log(`[DEBUG] Upload Progress: ${p}% (${e.loaded}/${e.total})`);
                         }
                     }
                });

                xhr.onreadystatechange = () => {
                     log(`[DEBUG] XHR State: ${xhr.readyState}, Status: ${xhr.status}`);
                };

                xhr.open('PUT', uploadUrl);
                
                // STANDARD HEADERS ONLY
                // We avoid X-Goog-* headers here to prevent CORS preflight issues.
                // Content-Range is standard and required for resumable sessions.
                const rangeHeader = `bytes 0-${audioBlob.size - 1}/${audioBlob.size}`;
                log(`[DEBUG] XHR Headers: Content-Type=${mimeType}`);
                log(`[DEBUG] XHR Headers: Content-Range=${rangeHeader}`);
                
                xhr.setRequestHeader('Content-Type', mimeType);
                xhr.setRequestHeader('Content-Range', rangeHeader);

                xhr.onload = () => {
                    log(`[DEBUG] XHR OnLoad. Status: ${xhr.status}`);
                    // Only log response text if small enough or error
                    const responseSnippet = xhr.responseText.substring(0, 200);
                    log(`[DEBUG] XHR Response: ${responseSnippet}...`);
                    
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const json = JSON.parse(xhr.responseText);
                            resolve(json);
                        } catch (e) {
                            // Sometimes the response is empty or not JSON, but status is OK
                            log("[DEBUG] Could not parse success JSON, assuming empty object.");
                            resolve({});
                        }
                    } else {
                        reject(new Error(`Server returned ${xhr.status}: ${xhr.responseText}`));
                    }
                };

                xhr.onerror = () => {
                    log(`[DEBUG] XHR OnError triggered. Status: ${xhr.status}`);
                    reject(new Error(`Network Error (XHR status: ${xhr.status})`));
                };

                log(`[DEBUG] Sending ${arrayBuffer.byteLength} bytes...`);
                xhr.send(arrayBuffer);
            });

            // Extract URI from response
            if (response.file && response.file.uri) {
                fileUri = response.file.uri;
            } else {
                // Should not happen with valid upload response
                log("[DEBUG] Warning: Upload succeeded but no URI in response body.");
                // Fallback: If we had the ID from handshake we could construct it, but we need the object from Google.
            }
            uploaded = true;
            log("Upload phase completed.");

        } catch (e: any) {
            console.error(`Upload attempt ${attempt} failed:`, e);
            log(`[DEBUG] Exception in attempt ${attempt}: ${e.message}`);
            if (attempt >= 3) {
                throw new Error(`Upload failed after 3 attempts. Last error: ${e.message}`);
            }
            log(`Upload failed (Attempt ${attempt}). Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    if (!fileUri) {
         throw new Error("File upload completed, but Google did not return a File URI.");
    }

    log(`File URI: ${fileUri}`);

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
