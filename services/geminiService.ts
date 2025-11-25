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
    
    log(`Starting Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB. Type: ${mimeType}`);

    // 1. Handshake (Server-side to protect API Key)
    log("Step 1: Requesting Upload URL via Netlify Proxy...");
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
    // We CANNOT use the proxy here because Netlify limits payload to 6MB, 
    // but Google requires chunks to be multiples of 8MB. It's a deadlock.
    // We must use Direct Upload.
    
    log("Step 2: Starting Direct Upload (Single PUT)...");
    
    // We use XHR instead of fetch to get better error reporting and avoid some CORS pitfalls
    await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        
        // CRITICAL: Google's signed URL protocol for "upload, finalize" in one go
        // requires specific headers to match the handshake.
        xhr.setRequestHeader('Content-Type', mimeType);
        xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
        xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
        
        // Debug logging for XHR lifecycle
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = ((e.loaded / e.total) * 100).toFixed(0);
                if (parseInt(percent) % 10 === 0) { // Log every 10%
                    log(`Uploading... ${percent}%`);
                }
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                log("Upload complete (200 OK).");
                resolve();
            } else {
                log(`Upload failed. Status: ${xhr.status} - ${xhr.statusText}`);
                log(`Response: ${xhr.responseText}`);
                reject(new Error(`Upload XHR Failed: ${xhr.status}`));
            }
        };

        xhr.onerror = () => {
            log(`Network Error (Status ${xhr.status}). This usually means CORS or Connection Reset.`);
            reject(new Error("Network Error during Direct Upload"));
        };

        xhr.send(audioBlob); 
    });

    log(`File upload finalized.`);

    // 3. Start Background Job
    // Since we don't get the file URI back from the PUT response easily in all cases,
    // we can assume the uploadUrl acts as the reference or we re-query via the backend 
    // if needed. However, the Gemini API usually returns the file metadata in the PUT response.
    // Let's grab the file URI from the XHR response if possible, or fallback.
    
    // Actually, for the background job we need the 'fileUri'. 
    // The 'uploadUrl' is temporary. The 'authorize_upload' step usually doesn't return the final fileUri.
    // The final response of the PUT request contains the file metadata including 'uri'.
    // We need to capture that JSON from the XHR.
    
    // NOTE: I need to refactor the XHR promise above to return the response JSON.
    
    // ... Refactoring Step 2 logic slightly to capture response ...
    
    const uploadResult = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Type', mimeType);
        xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
        xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
        
        xhr.onload = () => {
            if (xhr.status === 200) {
                try {
                    const json = JSON.parse(xhr.responseText);
                    resolve(json);
                } catch (e) {
                    reject(new Error("Invalid JSON response from Google Upload"));
                }
            } else {
                reject(new Error(`Upload XHR Failed: ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error("Network Error"));
        xhr.send(audioBlob);
    });

    const fileUri = uploadResult.file.uri;
    if (!fileUri) throw new Error("No file URI returned from Google.");
    
    log(`File URI obtained: ${fileUri}`);

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

// Deprecated since we use XHR direct upload now
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
