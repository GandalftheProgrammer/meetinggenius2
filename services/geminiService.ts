
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
    log(`Starting SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

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

    // 3. Generate (Standard Call with Heartbeat)
    log("Step 3: Sending generation request (Standard API)...");
    
    const genResponse = await fetch('/.netlify/functions/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', fileUri, mimeType, mode })
    });
    
    log(`Step 3: Connection Established. Status: ${genResponse.status}`);

    if (!genResponse.ok) {
        const errorText = await genResponse.text();
        log(`CRITICAL API ERROR: ${errorText.substring(0, 200)}...`);
        throw new Error(`Backend Error: ${errorText}`);
    }

    // STREAM READER LOGIC (To consume Heartbeats + Final JSON)
    const reader = genResponse.body?.getReader();
    if (!reader) throw new Error("Response body is not a stream");

    const decoder = new TextDecoder();
    let rawAccumulatedText = '';
    let hasReceivedHeartbeat = false;
    
    log("Step 4: Waiting for Gemini (Standard API processing)...");

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        
        // Check for heartbeats to reassure user
        if (chunk.includes("KEEP_ALIVE_PING")) {
             if (!hasReceivedHeartbeat) {
                 log("Heartbeat received (Gemini is thinking, connection active)...");
                 hasReceivedHeartbeat = true;
             }
        } else {
            // Log only when we get real data chunks to avoid spam
            if (chunk.trim().length > 5) {
                log(`Data chunk received (${chunk.length} bytes)`);
            }
        }
        
        rawAccumulatedText += chunk;
    }

    log(`Stream complete. Total Length: ${rawAccumulatedText.length}`);
    log("Step 5: Cleaning and Parsing Response...");
    
    // CRITICAL: Remove the Heartbeat tags before parsing JSON
    const cleanJsonText = rawAccumulatedText.replace(/<!-- KEEP_ALIVE_PING -->\n?/g, '');
    
    let fullText = "";
    
    try {
        // Try strict JSON parse first
        const parsedResponse = JSON.parse(cleanJsonText);
        
        // Handle Standard API Response (Single Object)
        if (!Array.isArray(parsedResponse)) {
            log("Format: Valid JSON Object detected (Standard API).");
            
            if (parsedResponse.error) {
                throw new Error(`Gemini API Error: ${JSON.stringify(parsedResponse.error)}`);
            }

            if (parsedResponse.candidates && 
                parsedResponse.candidates[0] && 
                parsedResponse.candidates[0].content && 
                parsedResponse.candidates[0].content.parts) {
                
                parsedResponse.candidates[0].content.parts.forEach((part: any) => {
                    if (part.text) fullText += part.text;
                });
            }
        } else {
            // Handle Legacy/Streamed Array Response (Just in case)
            log("Format: JSON Array detected.");
            parsedResponse.forEach((item: any) => {
                if (item.candidates && item.candidates[0] && item.candidates[0].content && item.candidates[0].content.parts) {
                    item.candidates[0].content.parts.forEach((part: any) => {
                        if (part.text) fullText += part.text;
                    });
                }
            });
        }
    } catch (e: any) {
        log(`JSON PARSE FAILED: ${e.message}`);
        log("--- RAW RESPONSE START (First 500 chars) ---");
        log(cleanJsonText.substring(0, 500)); 
        log("--- RAW RESPONSE END ---");
        
        if (cleanJsonText.trim().startsWith("<!DOCTYPE html>")) {
             throw new Error("Received HTML (likely a Server Timeout or 502 Bad Gateway) instead of JSON.");
        }

        // Attempt to just treat it as text if it's not JSON
        log("Attempting to use raw text as fallback...");
        fullText = cleanJsonText; 
    }

    if (!fullText) {
        throw new Error("Parsed result is empty. The model returned no text.");
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
        // Find the first '{' and last '}'
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        
        if (firstBrace === -1 || lastBrace === -1) {
             throw new Error("No JSON object found in text");
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
        // Return a partial success so the user sees *something*
        return {
            transcription: jsonText, // Put the raw text in transcription so they don't lose data
            summary: "Error parsing structured notes. See Transcription tab for raw output.",
            decisions: [],
            actionItems: []
        };
    }
}
