import { MeetingData, ProcessingMode } from '../types';
import { GoogleGenAI, Type } from "@google/genai";

// Environment Detection
const env = (import.meta as any).env;
const DIRECT_API_KEY = env?.VITE_GEMINI_API_KEY;
const IS_DEV_MODE = !!DIRECT_API_KEY; 

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL'
): Promise<MeetingData> => {
  
  if (IS_DEV_MODE) {
    console.log("Environment: Development (Direct API)");
    return processDevMode(audioBlob, mimeType, mode, DIRECT_API_KEY);
  } else {
    console.log("Environment: Production (Netlify Proxy)");
    return processProxyMode(audioBlob, mimeType, mode);
  }
};

/**
 * PRODUCTION MODE:
 * Uses Netlify Functions to proxy requests, hiding the API Key.
 * Supports streaming to avoid timeouts.
 */
async function processProxyMode(
    audioBlob: Blob, 
    mimeType: string, 
    mode: ProcessingMode
): Promise<MeetingData> {
    try {
        console.log(`Starting Proxy Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

        // 1. Handshake
        console.log("Step 1: Requesting Upload URL...");
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
            throw await parseBackendError(authResponse);
        }
        const { uploadUrl } = await authResponse.json();

        // 2. Chunk Loop
        const CHUNK_SIZE = 3 * 1024 * 1024;
        let offset = 0;
        let fileUri: string | null = null;
        
        console.log("Step 2: Starting Chunked Proxy Upload...");
        
        while (offset < audioBlob.size) {
            const chunkBlob = audioBlob.slice(offset, offset + CHUNK_SIZE);
            const chunkBase64 = await blobToBase64(chunkBlob);
            const isLast = offset + chunkBlob.size >= audioBlob.size;
            
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
                throw await parseBackendError(chunkResp);
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
        console.log(`Step 2 Complete. File URI: ${fileUri}`);

        // 3. Generate (Streamed)
        console.log("Step 3: generating (Streamed)...");
        const genResponse = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'generate', fileUri, mimeType, mode })
        });
        
        if (!genResponse.ok) {
            throw await parseBackendError(genResponse);
        }

        // Read stream
        const reader = genResponse.body?.getReader();
        if (!reader) throw new Error("Response body is not readable");

        const decoder = new TextDecoder();
        let jsonText = '';
        
        // Safety timeout loop
        while (true) {
            // If we don't get a chunk (or heartbeat) within 45 seconds, assume dead connection
            const readPromise = reader.read();
            const timeoutPromise = new Promise<any>((_, reject) => 
                setTimeout(() => reject(new Error("Connection timeout: No data received for 45s")), 45000)
            );

            const { done, value } = await Promise.race([readPromise, timeoutPromise]);
            
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            jsonText += chunk;
        }
        
        console.log("Stream complete. Parsing JSON...");
        return parseResponse(jsonText, mode);

    } catch (error) {
        console.error("Error in Proxy flow:", error);
        throw error;
    }
}

/**
 * DEVELOPMENT MODE:
 * Uses Client-side Gemini SDK directly.
 * Requires VITE_GEMINI_API_KEY in .env.local
 */
async function processDevMode(
    audioBlob: Blob, 
    mimeType: string, 
    mode: ProcessingMode,
    apiKey: string
): Promise<MeetingData> {
    try {
        console.log("Starting Dev Direct Flow...");
        
        const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': audioBlob.size.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file: { display_name: 'Dev_Audio_Test' } })
        });

        if (!initRes.ok) throw new Error(`Dev Upload Init Failed: ${await initRes.text()}`);
        const uploadUrl = initRes.headers.get('x-goog-upload-url');
        if (!uploadUrl) throw new Error("No upload URL returned");

        const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize'
            },
            body: audioBlob
        });

        if (!uploadRes.ok) throw new Error(`Dev Upload Content Failed: ${await uploadRes.text()}`);
        const uploadJson = await uploadRes.json();
        const fileUri = uploadJson.file.uri;
        console.log("Dev Upload Complete:", fileUri);

        const ai = new GoogleGenAI({ apiKey });
        
        let systemInstruction = `
        You are an expert professional meeting secretary. 
        Listen to the attached audio recording of a meeting.
        
        CRITICAL INSTRUCTION - SILENCE DETECTION:
        Before processing, verify if there is intelligible speech in the audio.
        - If the audio is silent or just noise, output the FALLBACK JSON.
        
        CRITICAL INSTRUCTION - LANGUAGE DETECTION:
        1. Detect the dominant language spoken in the audio.
        2. You MUST write the "summary", "decisions", and "actionItems" in that EXACT SAME LANGUAGE.
        
        FALLBACK JSON (Only if silence):
        {
            "transcription": "[No intelligible speech detected]",
            "summary": "No conversation was detected in the audio recording.",
            "decisions": [],
            "actionItems": []
        }
      `;

      let taskInstruction = "";
      const transcriptionSchema = { type: Type.STRING, description: "Full verbatim transcription" };
      const summarySchema = { type: Type.STRING, description: "A concise summary" };
      const decisionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key decisions" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Action items" };

      let schemaProperties: any = {};
      let requiredFields: string[] = [];

      if (mode === 'TRANSCRIPT_ONLY') {
        taskInstruction = "Your task is to Transcribe the audio verbatim. Do not generate summary or notes.";
        schemaProperties = { transcription: transcriptionSchema };
        requiredFields = ["transcription"];
      } else if (mode === 'NOTES_ONLY') {
        taskInstruction = "Your task is to create structured meeting notes.";
        schemaProperties = { summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["summary", "decisions", "actionItems"];
      } else {
        taskInstruction = "Your task is to Transcribe the audio verbatim AND create structured meeting notes.";
        schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, decisions: decisionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["transcription", "summary", "decisions", "actionItems"];
      }

      const result = await ai.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: {
            parts: [
                { fileData: { fileUri: fileUri, mimeType: mimeType } },
                { text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn the output strictly in JSON format." }
            ]
        },
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: schemaProperties,
                required: requiredFields,
            },
        }
      });

      return parseResponse(result.text || "{}", mode);

    } catch (e) {
        console.error("Dev Flow Error", e);
        throw e;
    }
}

// Helpers

async function parseBackendError(response: Response): Promise<Error> {
    const text = await response.text();
    let message = text;
    try {
        const json = JSON.parse(text);
        if (json.error) {
            message = json.error;
            if (typeof message === 'string' && message.startsWith('{')) {
                try {
                    const inner = JSON.parse(message);
                    message = inner.message || inner.error?.message || message;
                } catch { /* keep existing message */ }
            }
        }
    } catch {
        // ignore
    }
    
    if (response.status === 401) {
        message = "Unauthorized: Server configuration error. API_KEY may be missing.";
    } else if (response.status === 500 && !message) {
        message = `Server Error (${response.status})`;
    }

    return new Error(message);
}

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
        // Remove code blocks and TRIM to remove heartbeat spaces
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
            transcription: "Error parsing response or incomplete stream.",
            summary: "Error parsing response.",
            decisions: [],
            actionItems: []
        };
    }
}
