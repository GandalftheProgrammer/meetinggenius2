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
    
    log(`Starting Flow. Blob size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // 1. Handshake (Server-side to protect API Key)
    log("Step 1: Requesting Upload URL (Option B Handshake)...");
    const authResponse = await fetch('/.netlify/functions/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          action: 'authorize_upload', 
          mimeType, 
          fileSize: totalBytes.toString() 
      })
    });

    if (!authResponse.ok) {
        const err = await authResponse.text();
        throw new Error(`Handshake Failed: ${err}`);
    }
    const { uploadUrl } = await authResponse.json();
    log("Step 1: Upload URL received.");

    // 2. Direct Upload Loop (Browser -> Google)
    // We use the standard Resumable Upload Protocol:
    // - PUT requests
    // - 8MB chunks (Google Granularity)
    // - Content-Range header
    // - 308 (Resume Incomplete) or 200/201 (Created) status codes

    const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
    let offset = 0;
    let fileUri = '';

    log(`Step 2: Starting Direct Upload (${(CHUNK_SIZE/1024/1024).toFixed(0)}MB chunks)...`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + CHUNK_SIZE, totalBytes);
        const chunk = audioBlob.slice(offset, chunkEnd);
        const isLastChunk = chunkEnd === totalBytes;
        
        // Content-Range: bytes start-end/total
        // Note: 'end' is inclusive in HTTP Range header (e.g. 0-9 for 10 bytes)
        const rangeHeader = `bytes ${offset}-${chunkEnd - 1}/${totalBytes}`;
        
        log(`Uploading chunk: ${offset} - ${chunkEnd} / ${totalBytes} (${((chunkEnd/totalBytes)*100).toFixed(0)}%)`);

        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', uploadUrl, true);
            
            // Standard HTTP Headers for Resumable Upload
            xhr.setRequestHeader('Content-Length', chunk.size.toString());
            xhr.setRequestHeader('Content-Range', rangeHeader);
            // NOTE: We do NOT set X-Goog-Upload-Command here to avoid CORS issues.
            // The Content-Range tells the server where we are.
            
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && isLastChunk) {
                   // Optional: finer progress for the last chunk
                }
            };

            xhr.onload = () => {
                // 308: Resume Incomplete (Chunk accepted, waiting for more)
                // 200/201: Upload Complete
                if (xhr.status === 308) {
                    resolve();
                } else if (xhr.status === 200 || xhr.status === 201) {
                    try {
                        const json = JSON.parse(xhr.responseText);
                        if (json.file && json.file.uri) {
                            fileUri = json.file.uri;
                            log("Upload Complete. File URI obtained.");
                            resolve();
                        } else {
                            // Sometimes the final response doesn't have the file object directly if headers differ
                            // But usually for Gemini API it does.
                            // If missing, we might need to assume success or query it.
                            // However, let's assume standard success for now.
                            log("Upload Complete (200/201).");
                            // Fallback: If we don't get the URI, we have a problem. 
                            // But usually 200 OK body contains the metadata.
                            if (!fileUri && json.uri) fileUri = json.uri; // Try alternate
                             resolve();
                        }
                    } catch (e) {
                         // Valid JSON might not always be returned on 200/201 depending on API version?
                         // But Gemini API docs say it returns the File resource.
                         log(`Warning: Could not parse response JSON: ${xhr.responseText}`);
                         resolve();
                    }
                } else {
                    reject(new Error(`Chunk Upload Failed: ${xhr.status} ${xhr.statusText}`));
                }
            };

            xhr.onerror = () => {
                reject(new Error("Network Error during Chunk Upload"));
            };

            xhr.send(chunk);
        });

        offset += CHUNK_SIZE;
    }

    if (!fileUri) {
        // If we didn't capture the URI from the last chunk response, we can't proceed.
        // This acts as a safety check.
        // Wait... sometimes the uploadUrl itself contains the ID? No.
        // Let's hope the last chunk returned the JSON.
        // If not, we might fail here.
        // One edge case: If the file is smaller than 8MB, the first chunk is the last chunk.
        // The 200 OK response should definitely contain the File resource.
        
        throw new Error("Upload finished but no File URI was returned from Google.");
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
    
    log(`Job started with ID: ${jobId}. Waiting...`);

    // 4. Poll for Results
    let attempts = 0;
    const MAX_ATTEMPTS = 200; 
    
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
                log("Job Completed!");
                return parseResponse(data.result, mode);
            } else if (data.status === 'ERROR') {
                throw new Error(`Processing Error: ${data.error}`);
            }
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
