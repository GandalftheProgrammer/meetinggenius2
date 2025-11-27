import { GoogleGenAI } from "@google/genai";
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// NETLIFY BACKGROUND FUNCTION
// Reads chunks from storage, stitches them to 8MB, uploads to Gemini, and processes.

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  const apiKey = process.env.API_KEY;
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
    await resultStore.setJSON(jobId, { status: 'PROCESSING' });

    // Uploads Store
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // --- 1. INITIALIZE GEMINI UPLOAD ---
    // We use raw fetch here because we are implementing a specific chunk stitching logic 
    // to bypass Netlify Function payload limits, which might be hard to replicate 
    // with standard SDK file managers that expect local files.
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

    if (!initResp.ok) throw new Error(`Init Failed: ${await initResp.text()}`);
    
    const uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("No upload URL returned");

    // --- 2. STITCH & UPLOAD CHUNKS ---
    // Gemini requires chunks to be multiples of 8MB (8388608 bytes).
    // Our storage chunks are 4MB. We must stitch them.
    
    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        // Read Chunk from Storage
        const chunkKey = `${jobId}/${i}`;
        const chunkBase64 = await uploadStore.get(chunkKey);
        
        if (!chunkBase64) throw new Error(`Missing chunk ${i}`);
        
        // Append to buffer
        const chunkBuffer = Buffer.from(chunkBase64, 'base64');
        buffer = Buffer.concat([buffer, chunkBuffer]);

        // Clean up storage immediately to free space
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

            if (!upResp.ok) throw new Error(`Upload Failed at ${uploadOffset}: ${await upResp.text()}`);
            
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // --- 3. FINALIZE ---
    // Send remainder (if any) with 'finalize' command
    const isFinal = true;
    const finalSize = buffer.length;
    console.log(`[Background] Finalizing with ${finalSize} bytes at offset ${uploadOffset}...`);

    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(finalSize),
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset)
        },
        body: buffer
    });

    if (!finalResp.ok) throw new Error(`Finalize Failed: ${await finalResp.text()}`);

    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;
    
    console.log(`[Background] Upload Complete. File URI: ${fileUri}`);

    // --- 4. WAIT FOR ACTIVE ---
    await waitForFileActive(fileUri, apiKey);

    // --- 5. GENERATE CONTENT ---
    const resultText = await generateContent(fileUri, mimeType, mode, model, apiKey);

    // Save Result
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

  } catch (err: any) {
    console.error(`[Background] Error: ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

async function waitForFileActive(fileUri: string, apiKey: string) {
    let attempts = 0;
    while (attempts < 60) {
        const r = await fetch(`${fileUri}?key=${apiKey}`);
        const d = await r.json();
        if (d.state === 'ACTIVE') return;
        if (d.state === 'FAILED') throw new Error("File processing failed");
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error("Timeout waiting for file");
}

async function generateContent(fileUri: string, mimeType: string, mode: string, model: string, apiKey: string) {
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
}