
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
    
    log(`[GeminiService] Init - Blob Size: ${audioBlob.size} bytes`);
    log(`[GeminiService] Init - Blob Type: ${audioBlob.type}`);
    log(`[GeminiService] Init - Computed MimeType: ${mimeType}`);

    // 1. Handshake (Get Upload URL)
    log("[GeminiService] Step 1: Requesting Upload URL via Netlify Proxy...");
    const authResponse = await fetch('/.netlify/functions/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          action: 'authorize_upload', 
          mimeType, 
          fileSize: audioBlob.size.toString() 
      })
    });

    log(`[GeminiService] Handshake Response Status: ${authResponse.status} ${authResponse.statusText}`);

    if (!authResponse.ok) {
        const err = await authResponse.text();
        throw new Error(`Handshake Failed: ${err}`);
    }
    const { uploadUrl } = await authResponse.json();
    
    if (!uploadUrl) throw new Error("Handshake succeeded but no uploadUrl returned.");
    log(`[GeminiService] Handshake Success. Upload URL obtained.`);

    // 2. Direct Upload (Browser -> Google) via XMLHttpRequest
    // STRATEGY: Clean Monolithic PUT.
    // We send the entire payload in one go.
    // We DO NOT send X-Goog-Upload-Command or Content-Range headers, as these often trigger CORS preflight failures in browsers.
    // We rely on the initial handshake (where we sent the file size) for the server to know when the upload is complete.
    
    log(`[GeminiService] Step 2: Starting Direct Upload (XHR)...`);
    
    // Convert to ArrayBuffer to ensure clean transmission without browser auto-headers
    log("[GeminiService] Converting Blob to ArrayBuffer...");
    const arrayBuffer = await audioBlob.arrayBuffer();
    log(`[GeminiService] ArrayBuffer created. ByteLength: ${arrayBuffer.byteLength}`);
    
    let fileUri: string | null = null;
    let attempt = 0;
    let uploaded = false;

    while (attempt < 3 && !uploaded) {
        attempt++;
        log(`[GeminiService] --- Upload Attempt ${attempt} ---`);
        try {
            const response = await new Promise<any>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                
                // Detailed Event Listeners for Debugging
                xhr.addEventListener('loadstart', () => log(`[XHR Event] loadstart`));
                xhr.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                         const p = Math.floor((e.loaded / e.total) * 100);
                         if (p % 20 === 0) log(`[XHR Event] progress: ${p}%`);
                    }
                });
                xhr.addEventListener('error', () => log(`[XHR Event] error`));
                xhr.addEventListener('abort', () => log(`[XHR Event] abort`));
                xhr.addEventListener('timeout', () => log(`[XHR Event] timeout`));
                xhr.addEventListener('load', () => log(`[XHR Event] load (finished)`));
                xhr.addEventListener('loadend', () => log(`[XHR Event] loadend`));

                xhr.onreadystatechange = () => {
                     // ReadyState 2 = HEADERS_RECEIVED, 4 = DONE
                     if (xhr.readyState === 2 || xhr.readyState === 4) {
                        log(`[XHR State] ReadyState: ${xhr.readyState}, Status: ${xhr.status}`);
                     }
                };

                xhr.open('PUT', uploadUrl);
                
                // CRITICAL: NO CUSTOM HEADERS
                // We send raw bytes. The server knows the size and type from the handshake.
                // Sending custom headers like 'X-Goog-Upload-Command' triggers CORS 'Failed to fetch' / Network Error.
                log(`[GeminiService] Sending raw ArrayBuffer via PUT. No custom headers.`);

                xhr.onload = () => {
                    log(`[XHR OnLoad] Status: ${xhr.status}`);
                    
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const responseText = xhr.responseText;
                            log(`[XHR Response] Body length: ${responseText.length}`);
                            const json = JSON.parse(responseText);
                            resolve(json);
                        } catch (e) {
                            // Sometimes Google returns empty body on success for certain commands, 
                            // but usually returns the File object on completion.
                            log("[GeminiService] Could not parse success JSON (or empty), assuming success.");
                            resolve({});
                        }
                    } else {
                        log(`[XHR Error Body] ${xhr.responseText}`);
                        reject(new Error(`Server returned ${xhr.status}: ${xhr.statusText}`));
                    }
                };

                xhr.onerror = () => {
                    log(`[XHR OnError] Network Error. Status: ${xhr.status}`);
                    reject(new Error(`Network Error (XHR status: ${xhr.status}) - Likely CORS or Connection Reset`));
                };

                xhr.send(arrayBuffer);
            });

            // Extract URI from response
            if (response.file && response.file.uri) {
                fileUri = response.file.uri;
                log(`[GeminiService] Upload Complete. File URI: ${fileUri}`);
            } else {
                // If we don't get the URI in the response, we can't proceed.
                log("[GeminiService] Warning: Upload request finished but no 'file.uri' in response.");
                log(`[GeminiService] Response dump: ${JSON.stringify(response)}`);
                throw new Error("Google API did not return a File URI.");
            }
            uploaded = true;

        } catch (e: any) {
            console.error(`Upload attempt ${attempt} failed:`, e);
            log(`[GeminiService] Exception in attempt ${attempt}: ${e.message}`);
            if (attempt >= 3) {
                throw new Error(`Upload failed after 3 attempts. Last error: ${e.message}`);
            }
            log(`[GeminiService] Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    if (!fileUri) {
         throw new Error("File upload process completed without a valid File URI.");
    }

    // 3. Start Background Job
    log(`[GeminiService] Step 3: Queuing Background Job...`);
    log(`[GeminiService] Model: ${model}`);
    
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
    
    log(`[GeminiService] Job started with ID: ${jobId}. Polling for results...`);

    // 4. Poll for results
    let attempts = 0;
    const MAX_ATTEMPTS = 200; // 10 minutes max
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        
        if (attempts % 5 === 0) {
            log(`[GeminiService] Polling (Attempt ${attempts})...`);
        }

        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            if (data.status === 'COMPLETED' && data.result) {
                log("[GeminiService] Job COMPLETED! Result received.");
                return parseResponse(data.result, mode);
            } else if (data.status === 'ERROR') {
                throw new Error(`Background Processing Error: ${data.error}`);
            } else if (data.status === 'PROCESSING') {
                // continue polling
            }
        } else if (pollResp.status !== 404) {
            log(`[GeminiService] Polling HTTP Error: ${pollResp.status} ${pollResp.statusText}`);
        }
    }

    throw new Error("Timeout: Background job took too long to complete.");

  } catch (error) {
    console.error("Error in SaaS flow:", error);
    if (error instanceof Error) {
        log(`[GeminiService] FATAL ERROR: ${error.message}`);
    }
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
