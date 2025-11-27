
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
    // We use the Header-Based Resumable Upload Protocol (Option B Variant)
    
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
    let offset = 0;
    let fileUri = '';

    log(`Step 2: Starting Direct Upload (${(CHUNK_SIZE/1024/1024).toFixed(0)}MB chunks)...`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const isLastChunk = chunkEnd === totalBytes;
        
        // Strict command logic
        const command = isLastChunk ? 'upload, finalize' : 'upload';
        
        const progress = Math.round((chunkEnd / totalBytes) * 100);
        log(`Uploading chunk: ${offset} - ${chunkEnd} / ${totalBytes} (${progress}%) [${command}]`);

        // Prepare headers explicitly
        const headers: Record<string, string> = {
            'Content-Length': chunkBlob.size.toString(),
            'X-Goog-Upload-Offset': offset.toString(),
            'X-Goog-Upload-Command': command
        };
        
        log(`Headers: ${JSON.stringify(headers)}`);

        try {
            const response = await fetch(uploadUrl, {
                method: 'POST',
                headers: headers,
                body: chunkBlob
            });

            log(`Chunk Response Status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Chunk Upload Failed [${response.status}]: ${errorText}`);
            }

            // If this was the last chunk, we expect the file URI in the response
            if (isLastChunk) {
                log("Final chunk sent. Reading response JSON...");
                try {
                    const result = await response.json();
                    console.log("Full Finalize Response:", result);

                    if (result.file && result.file.uri) {
                        fileUri = result.file.uri;
                    } else if (result.uri) {
                         // Fallback structure
                        fileUri = result.uri;
                    }
                    
                    if (fileUri) {
                        log(`Upload Complete. File URI obtained: ${fileUri}`);
                    } else {
                        log("Warning: Final response OK but URI not found in standard paths.");
                    }
                } catch (jsonErr) {
                    console.error("JSON Parse Error on Final Chunk:", jsonErr);
                    // Sometimes the server returns 200 OK without JSON on finalization if headers were mixed?
                    // But for 'upload, finalize', it SHOULD return JSON.
                    throw new Error("Failed to parse final response from Google.");
                }
            }
        } catch (fetchErr: any) {
            log(`Network/Fetch Error on chunk starting at ${offset}: ${fetchErr.message}`);
            // Check if it's a "Failed to fetch" which is often CORS or Connection Closed
            if (fetchErr.message === 'Failed to fetch') {
                log("Suggestion: This often indicates a CORS Preflight failure or the server closed the connection unexpectedly.");
            }
            throw fetchErr;
        }

        offset += CHUNK_SIZE;
    }

    if (!fileUri) {
        throw new Error("Upload finished but no File URI was returned from Google.");
    }
    
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

    // 4. Poll for results
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
