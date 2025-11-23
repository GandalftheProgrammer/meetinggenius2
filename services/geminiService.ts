import { MeetingData, ProcessingMode } from '../types';
import { GoogleGenAI, Type } from "@google/genai";

// Environment Detection
const env = (import.meta as any).env;
const API_KEY_ENV = env?.VITE_GEMINI_API_KEY;
const IS_DEV_MODE = typeof API_KEY_ENV === 'string' && API_KEY_ENV.length > 0;

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL'
): Promise<MeetingData> => {
  
  if (IS_DEV_MODE) {
    console.log("Environment: Development (Direct API Stream)");
    return processDevMode(audioBlob, mimeType, mode, API_KEY_ENV);
  } else {
    console.log("Environment: Production (Netlify Proxy Stream)");
    return processProxyMode(audioBlob, mimeType, mode);
  }
};

/**
 * PRODUCTION MODE:
 * Proxy request -> Netlify Function -> Gemini
 */
async function processProxyMode(
    audioBlob: Blob, 
    mimeType: string, 
    mode: ProcessingMode
): Promise<MeetingData> {
    try {
        console.log(`Starting Proxy Flow. Size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

        // 1. Handshake
        const authResponse = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'authorize_upload', 
                mimeType, 
                fileSize: audioBlob.size.toString() 
            })
        });

        if (!authResponse.ok) throw await parseBackendError(authResponse);
        const { uploadUrl } = await authResponse.json();

        // 2. Upload
        const CHUNK_SIZE = 3 * 1024 * 1024;
        let offset = 0;
        let fileUri: string | null = null;
        
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
            
            if (!chunkResp.ok) throw await parseBackendError(chunkResp);
            
            if (isLast) {
                const result = await chunkResp.json();
                fileUri = result.file?.uri;
            }
            offset += CHUNK_SIZE;
        }

        if (!fileUri) throw new Error("Upload finalized but no File URI returned.");

        // 3. Generate (Streamed)
        const genResponse = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'generate', fileUri, mimeType, mode })
        });
        
        if (!genResponse.ok) throw await parseBackendError(genResponse);
        if (!genResponse.body) throw new Error("Response body is not readable");

        return readStreamAndParse(genResponse.body.getReader());

    } catch (error) {
        console.error("Proxy Flow Error:", error);
        throw error;
    }
}

/**
 * DEVELOPMENT MODE:
 * Direct Client -> Gemini
 * Uses direct GoogleGenAI SDK but processes logic similarly to Prod.
 */
async function processDevMode(
    audioBlob: Blob, 
    mimeType: string, 
    mode: ProcessingMode,
    apiKey: string
): Promise<MeetingData> {
    try {
        console.log("Starting Dev Direct Flow...");
        
        // 1. Direct Upload
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
                'Content-Length': audioBlob.size.toString(),
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize'
            },
            body: audioBlob
        });

        if (!uploadRes.ok) throw new Error(`Dev Upload Content Failed: ${await uploadRes.text()}`);
        const uploadJson = await uploadRes.json();
        const fileUri = uploadJson.file.uri;

        // 2. Direct Generate
        const ai = new GoogleGenAI({ apiKey });
        const { systemInstruction, taskInstruction, schemaProperties, requiredFields } = getPromptsAndSchema(mode);

        const resultStream = await ai.models.generateContentStream({
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

        let fullText = "";
        for await (const chunk of resultStream) {
            fullText += chunk.text();
        }

        return parseFinalJSON(fullText);

    } catch (e) {
        console.error("Dev Flow Error", e);
        throw e;
    }
}

// --- Shared Logic ---

async function readStreamAndParse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<MeetingData> {
    const decoder = new TextDecoder();
    let jsonText = '';
    let hasReceivedData = false;
    
    try {
        while (true) {
            // Wait up to 60s for the next chunk (heartbeats keep this alive)
            const timeoutPromise = new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error("Network Timeout: Connection lost.")), 60000)
            );

            const { done, value } = await Promise.race([
                reader.read(),
                timeoutPromise
            ]);

            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            
            // If we receive data, the connection is alive
            if (chunk.trim().length > 0) {
                hasReceivedData = true;
            }
            
            jsonText += chunk;
        }
    } catch (e: any) {
        console.error("Stream reading failed", e);
        throw e;
    } finally {
        reader.releaseLock();
    }

    if (!hasReceivedData && jsonText.trim().length === 0) {
         throw new Error("No data received from AI service.");
    }

    return parseFinalJSON(jsonText);
}

function getPromptsAndSchema(mode: ProcessingMode) {
    const systemInstruction = `
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

    return { systemInstruction, taskInstruction, schemaProperties, requiredFields };
}

async function parseBackendError(response: Response): Promise<Error> {
    const text = await response.text();
    let message = text;
    try {
        const json = JSON.parse(text);
        if (json.error) message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
    } catch { /* ignore */ }
    
    if (response.status === 401) return new Error("Unauthorized: API Key missing or invalid.");
    return new Error(message || `Server Error ${response.status}`);
}

function parseFinalJSON(jsonText: string): MeetingData {
    try {
        // Remove markdown code blocks if present
        const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        if (!cleanText) throw new Error("Received empty response from AI.");

        const rawData = JSON.parse(cleanText);

        if (rawData.error) throw new Error(`Gemini Error: ${rawData.error}`);

        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            decisions: rawData.decisions || [],
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("JSON Parse Error. Raw Text:", jsonText);
        let msg = "Failed to parse AI response.";
        if (e instanceof Error) msg += " " + e.message;
        
        // Return partial data for debugging if meaningful JSON exists
        if (jsonText.includes('"transcription"')) {
             return {
                transcription: jsonText,
                summary: "Error parsing full notes.",
                decisions: [],
                actionItems: []
            };
        }
        throw new Error(msg);
    }
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
