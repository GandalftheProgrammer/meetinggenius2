
import { MeetingData, ProcessingMode } from '../types';

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL',
  onLog: (msg: string) => void
): Promise<MeetingData> => {
  try {
    onLog(`Starting SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

    // 1. Handshake: Get authorized Upload URL from Backend
    onLog("Step 1: Requesting Upload URL...");
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
    onLog("Step 1: Upload URL received.");

    // 2. Chunk Loop: Send data to Backend -> Backend sends to Google
    const CHUNK_SIZE = 3 * 1024 * 1024; // 3MB chunks
    let offset = 0;
    let fileUri: string | null = null;
    
    onLog("Step 2: Starting Chunked Upload...");
    
    while (offset < audioBlob.size) {
        const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
        const chunkBase64 = await blobToBase64(chunkBlob);
        const isLast = offset + chunkBlob.size >= audioBlob.size;
        
        onLog(`Uploading chunk offset ${offset}...`);

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
                onLog(`File upload finalized. URI: ${fileUri}`);
            } else {
                throw new Error("Upload finalized but no File URI returned.");
            }
        }
        offset += CHUNK_SIZE;
    }

    if (!fileUri) throw new Error("File URI missing after upload.");

    // 3. Generate: Ask Backend to process the file (STREAMING)
    onLog("Step 3: Sending generation request...");
    const genResponse = await fetch('/.netlify/functions/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', fileUri, mimeType, mode })
    });
    
    if (!genResponse.ok) {
      const errorText = await genResponse.text();
      throw new Error(`Generation Request Failed: ${errorText}`);
    }

    onLog("Stream connection established. Reading response...");
    const reader = genResponse.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let jsonText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        jsonText += chunk;
        // Optional: onLog(`Received stream chunk: ${chunk.length} bytes`);
    }
    
    onLog("Stream complete. Parsing JSON...");
    return parseResponse(jsonText, mode);

  } catch (error) {
    onLog(`CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
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
        const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const rawData = JSON.parse(cleanText);
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            decisions: rawData.decisions || [],
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("Failed to parse JSON from AI", jsonText);
        return {
            transcription: "Error parsing response.",
            summary: "Error parsing response.",
            decisions: [],
            actionItems: []
        };
    }
}
