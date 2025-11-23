
import { MeetingData, ProcessingMode } from '../types';

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL',
  onLog?: (msg: string) => void
): Promise<MeetingData> => {
  const log = (msg: string) => {
      console.log(msg);
      if (onLog) onLog(msg);
  };

  try {
    log(`Starting Async SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

    // 1. Handshake
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

    // 2. Chunk Upload
    const CHUNK_SIZE = 3 * 1024 * 1024; // 3MB chunks
    let offset = 0;
    let fileUri: string | null = null;
    
    log("Step 2: Starting Chunked Upload...");
    
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        const chunkBase64 = await blobToBase64(chunkBlob);
        const isLast = offset + chunkBlob.size >= audioBlob.size;
        
        log(`Uploading chunk offset ${offset}...`);

        const chunkResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'upload_chunk',
                uploadUrl,
                chunkData: chunkBase64,
                offset: offset.toString(),
                totalSize: audioBlob.size.toString(),
                isLastChunk: isLast
            })
        });
        
        if (!chunkResp.ok) {
             const err = await chunkResp.text();
             throw new Error(`Chunk Upload Failed: ${err}`);
        }
        
        if (isLast) {
            const result = await chunkResp.json();
            if (result.file && result.file.uri) {
                fileUri = result.file.uri;
            } else {
                throw new Error("Upload finalized but no File URI returned from Google.");
            }
        }
        offset += CHUNK_SIZE;
    }

    if (!fileUri) throw new Error("File URI missing after upload.");
    log(`File upload finalized. URI: ${fileUri}`);

    // 3. Start Background Job
    log("Step 3: Starting Background Job...");
    
    // Generate a unique ID for this job
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Note: We call the background function endpoint
    const startResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUri, mimeType, mode, jobId })
    });

    // Netlify Background functions return 202 Accepted immediately if queued successfully
    if (startResp.status !== 202 && !startResp.ok) {
        throw new Error(`Failed to start background job: ${await startResp.text()}`);
    }
    
    log(`Job started with ID: ${jobId}. Waiting for results...`);

    // 4. Poll for Results
    let attempts = 0;
    const MAX_ATTEMPTS = 120; // 120 * 3s = 6 minutes max wait
    
    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds
        
        // Log a "heartbeat" to the UI every 15 seconds (every 5th attempt)
        if (attempts % 5 === 0) {
            log(`Checking status (Attempt ${attempts}/${MAX_ATTEMPTS})...`);
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
        // Clean markdown code blocks if present
        const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        // Find the first '{' and last '}'
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        
        if (firstBrace === -1 || lastBrace === -1) {
             // Fallback: treat as plain text if we asked for JSON but got text
             return {
                 transcription: jsonText,
                 summary: "Raw text received (could not parse JSON)",
                 decisions: [],
                 actionItems: []
             };
        }
        
        const jsonOnly = cleanText.substring(firstBrace, lastBrace + 1);
        const rawData = JSON.parse(jsonOnly);
        
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            decisions: rawData.decisions || [],
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("Failed to parse inner JSON structure", e);
        return {
            transcription: jsonText, 
            summary: "Error parsing structured notes.",
            decisions: [],
            actionItems: []
        };
    }
}
