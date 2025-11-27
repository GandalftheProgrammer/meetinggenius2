import { GoogleGenAI } from "@google/genai";
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// NETLIFY BACKGROUND FUNCTION
// Reads chunks from storage, stitches them to 8MB, uploads to Gemini, and processes.

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  // FIX: Trim whitespace from API Key. Trailing newlines cause 401s in raw fetch calls.
  const apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  
  if (!apiKey) {
      console.error("API_KEY missing");
      return;
  }

  let jobId: string = "";

  try {
    const payload = await req.json();
    const { totalChunks, mimeType, mode, model, fileSize } = payload;
    jobId = payload.jobId;

    if (!jobId) return;

    console.log(`[Background] Starting job ${jobId}. Chunks: ${totalChunks}. Size: ${fileSize}`);

    // Results Store
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    // Uploads Store
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // Helper to update status
    const updateStatus = async (msg: string) => {
        console.log(`[Background] ${msg}`);
        // We only update the store if needed, mostly we just log to console which Netlify captures
    };

    // --- 1. INITIALIZE GEMINI UPLOAD ---
    await updateStatus("Checkpoint 1: Initializing Resumable Upload...");
    
    const initResp = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: `Meeting_${jobId}` } })
    });

    if (!initResp.ok) {
        const errText = await initResp.text();
        throw new Error(`Init Handshake Failed (${initResp.status}): ${errText}`);
    }
    
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("No upload URL returned from Google");

    // CRITICAL FIX: The returned uploadUrl usually does NOT contain the API key.
    // We must manually append it to ensure subsequent PUT/POST requests are authenticated.
    if (!uploadUrl.includes('key=')) {
        const separator = uploadUrl.includes('?') ? '&' : '?';
        uploadUrl = `${uploadUrl}${separator}key=${apiKey}`;
    }

    // --- 2. STITCH & UPLOAD CHUNKS ---
    await updateStatus("Checkpoint 2: Stitching and Uploading Chunks...");
    
    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        // Read Chunk from Storage
        const chunkKey = `${jobId}/${i}`;
        // Explicitly cast to string because get() can return Blob/ArrayBuffer which Buffer.from doesn't accept with encoding
        const chunkBase64 = await uploadStore.get(chunkKey) as unknown as string;
        
        if (!chunkBase64) throw new Error(`Missing chunk ${i} in storage`);
        
        // Append to buffer
        const chunkBuffer = Buffer.from(chunkBase64, 'base64');
        buffer = Buffer.concat([buffer, chunkBuffer]);

        // Clean up storage immediately
        await uploadStore.delete(chunkKey);

        // While we have enough data for a Gemini chunk, send it
        while (buffer.length >= GEMINI_CHUNK_SIZE) {
            const chunkToSend = buffer.subarray(0, GEMINI_CHUNK_SIZE);
            buffer = buffer.subarray(GEMINI_CHUNK_SIZE); // Keep remainder

            console.log(`[Background] Uploading 8MB chunk at offset ${uploadOffset}...`);
            
            const upResp = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Length': String(GEMINI_CHUNK_SIZE),
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset)
                },
                body: chunkToSend
            });

            if (!upResp.ok) {
                 const errText = await upResp.text();
                 throw new Error(`Chunk Upload Failed at ${uploadOffset} (${upResp.status}): ${errText}`);
            }
            
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // --- 3. FINALIZE ---
    await updateStatus("Checkpoint 3: Finalizing Upload...");
    
    const isFinal = true;
    const finalSize = buffer.length;
    
    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(finalSize),
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset)
        },
        body: buffer
    });

    if (!finalResp.ok) {
        const errText = await finalResp.text();
        throw new Error(`Finalize Failed (${finalResp.status}): ${errText}`);
    }

    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;
    
    console.log(`[Background] File Uploaded Successfully: ${fileUri}`);

    // --- 4. WAIT FOR ACTIVE ---
    await updateStatus("Checkpoint 4: Waiting for File Processing...");
    await waitForFileActive(fileUri, apiKey);

    // --- 5. GENERATE CONTENT ---
    await updateStatus("Checkpoint 5: Generating Content...");
    const resultText = await generateContent(fileUri, mimeType, mode, model, apiKey);

    // Save Result
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });
    console.log(`[Background] Job ${jobId} Completed Successfully.`);

  } catch (err: any) {
    console.error(`[Background] FATAL ERROR: ${err.message}`);
    // Extract meaningful message if it's a JSON string
    let errorMessage = err.message;
    try {
        if (errorMessage.startsWith('{')) {
            const jsonErr = JSON.parse(errorMessage);
            errorMessage = jsonErr.error?.message || errorMessage;
        }
    } catch (e) {}

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: errorMessage });
  }
};

async function waitForFileActive(fileUri: string, apiKey: string) {
    let attempts = 0;
    while (attempts < 60) {
        // Appending key is crucial here too
        const r = await fetch(`${fileUri}?key=${apiKey}`);
        
        if (!r.ok) {
             if (r.status === 404) throw new Error("File not found during polling");
             // Retry on temporary errors
        } else {
            const d = await r.json();
            if (d.state === 'ACTIVE') return;
            if (d.state === 'FAILED') throw new Error(`File processing failed state: ${d.state}`);
        }
        
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error("Timeout waiting for file to become ACTIVE");
}

async function generateContent(fileUri: string, mimeType: string, mode: string, model: string, apiKey: string) {
    try {
        const ai = new GoogleGenAI({ apiKey });

        const systemInstruction = `You are an expert meeting secretary.
        1. Detect the language and write notes in that language.
        2. If silent/noise, return fallback JSON.
        3. Action items must be EXPLICIT tasks only.
        `;

        let taskInstruction = "";
        if (mode === 'TRANSCRIPT_ONLY') taskInstruction = "Transcribe verbatim.";
        else if (mode === 'NOTES_ONLY') taskInstruction = "Create structured notes.";
        else taskInstruction = "Transcribe verbatim AND create structured notes.";

        const response = await ai.models.generateContent({
            model: model,
            contents: {
                parts: [
                    { fileData: { fileUri, mimeType } },
                    { text: taskInstruction + "\n\nReturn JSON." }
                ]
            },
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json",
                maxOutputTokens: 8192
            }
        });

        return response.text || "{}";
    } catch (error: any) {
        throw new Error(`Gemini Generation Failed: ${error.message || error}`);
    }
}