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
    log(`Starting SaaS Flow (Chunked Proxy). Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

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

    // 3. Generate (Streaming)
    log("Step 3: Sending generation request (Streaming)...");
    
    const genResponse = await fetch('/.netlify/functions/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', fileUri, mimeType, mode })
    });
    
    if (!genResponse.ok) throw new Error(await genResponse.text());

    // STREAM READER LOGIC for Raw REST API
    const reader = genResponse.body?.getReader();
    if (!reader) throw new Error("Response body is not a stream");

    const decoder = new TextDecoder();
    let rawAccumulatedText = '';
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawAccumulatedText += chunk;
        // Since we are piping the raw REST response, it comes as a JSON array of objects: [{...}, {...}]
        // We accumulate the full text and parse at the end for simplicity, 
        // BUT the act of reading the stream keeps the connection alive, preventing timeout.
    }

    log("Generation complete. Parsing Streamed Data...");
    
    // The raw stream is a JSON array: [ {candidates: ...}, {candidates: ...} ]
    // We need to parse this array and concatenate the text parts.
    // However, sometimes it comes as multiple JSON objects concatenated or a proper array.
    // The Google REST API returns an array `[...]`.
    
    let fullText = "";
    
    try {
        const responseArray = JSON.parse(rawAccumulatedText);
        if (Array.isArray(responseArray)) {
            responseArray.forEach((item: any) => {
                if (item.candidates && item.candidates[0] && item.candidates[0].content && item.candidates[0].content.parts) {
                    item.candidates[0].content.parts.forEach((part: any) => {
                        if (part.text) fullText += part.text;
                    });
                }
            });
        }
    } catch (e) {
        // Fallback: If JSON is malformed (e.g. error in stream), try to extract what we can
        console.warn("Could not parse full JSON array, attempting raw text extraction", e);
        fullText = rawAccumulatedText; 
    }

    return parseResponse(fullText, mode);

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
        const rawData = JSON.parse(cleanText);
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            decisions: rawData.decisions || [],
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("Failed to parse JSON from AI", jsonText);
        // Try to salvage partial data if possible, otherwise return error state
        return {
            transcription: "Error parsing response. The model generated invalid JSON.",
            summary: "Error parsing response",
            decisions: [],
            actionItems: []
        };
    }
}