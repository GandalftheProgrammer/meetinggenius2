
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

    // 2. Direct Upload (Browser -> Google)
    // CRITICAL FIX: We use a 1GB chunk size to force the upload to happen in a SINGLE request.
    // The previous chunking logic (8MB) caused stability issues on the final chunk for files > 8MB.
    // By sending the whole file at once, we use the exact same logic that works for small files.
    const CHUNK_SIZE = 1024 * 1024 * 1024; // 1GB limit
    let offset = 0;
    let fileUri: string | null = null;
    
    log("Step 2: Starting Direct Upload...");
    
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        const isLast = offset + chunkBlob.size >= audioBlob.size;
        
        // Use XHR for better reliability with binary uploads than fetch
        // and to avoid "Failed to fetch" opacity
        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl, true);
            
            // Google Resumable Protocol Headers
            // Note: We do NOT set Content-Length manually, the browser does it safely.
            xhr.setRequestHeader('X-Goog-Upload-Offset', offset.toString());
            xhr.setRequestHeader('X-Goog-Upload-Command', isLast ? 'upload, finalize' : 'upload');
            
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percent = ((offset + e.loaded) / audioBlob.size) * 100;
                    if (percent % 10 === 0 || percent > 90) {
                        log(`Uploading... ${percent.toFixed(0)}%`);
                    }
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (isLast) {
                        try {
                            const result = JSON.parse(xhr.responseText);
                            if (result.file && result.file.uri) {
                                fileUri = result.file.uri;
                            } else if (result.uri) {
                                fileUri = result.uri;
                            } else {
                                reject(new Error("Upload finalized but no File URI returned."));
                                return;
                            }
                        } catch (e) {
                            reject(new Error("Failed to parse upload response JSON"));
                            return;
                        }
                    }
                    resolve();
                } else {
                    reject(new Error(`Upload failed. Status: ${xhr.status} ${xhr.statusText}`));
                }
            };

            xhr.onerror = () => reject(new Error(`Network Error during upload (Status ${xhr.status})`));
            
            xhr.send(chunkBlob);
        });

        offset += CHUNK_SIZE;
    }

    if (!fileUri) throw new Error("File URI missing after upload.");
    log(`File upload finalized. URI: ${fileUri}`);

    // 3. Start Background Job
    log(`Step 3: Queuing Background Job with model: ${model}...`);
    
    // Generate a unique ID for this job
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Note: We call the background function endpoint
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

    // 4. Poll for Results
    let attempts = 0;
    const MAX_ATTEMPTS = 200; // 200 * 3s = 10 minutes max wait
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds
        
        // Log a "heartbeat" to the UI periodically
        if (attempts % 5 === 0) {
            log(`Checking status (Attempt ${attempts})...`);
        }

        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            // Success!
            const data = await pollResp.json();
            if (data.status === 'COMPLETED' && data.result) {
                log("Job Completed! Result received.");
                return parseResponse(data.result, mode);
            } else if (data.status === 'ERROR') {
                throw new Error(`Background Processing Error: ${data.error}`);
            }
            // If status is 'PROCESSING', continues loop
        } else if (pollResp.status === 404) {
             // Job ID not found yet (worker might be starting up), continue
        } else {
            // Actual network error
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
