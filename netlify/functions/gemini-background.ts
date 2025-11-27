import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// NETLIFY BACKGROUND FUNCTION
// Reads chunks from storage, stitches them to 8MB, uploads to Gemini via REST API, and processes.

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  // FIX: Trim whitespace from API Key.
  // FIX: Remove any surrounding quotes if they exist in the env var string
  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) {
      apiKey = apiKey.slice(1, -1);
  }
  
  if (!apiKey) {
      console.error("API_KEY missing");
      return;
  }

  // ENCODE KEY: Ensure no special characters break URL parameters
  const encodedKey = encodeURIComponent(apiKey);

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
    };

    // --- 0. PRE-FLIGHT CONNECTIVITY TEST (RAW REST) ---
    // Verifies if the API Key works in this server environment (checking for Referrer/IP restrictions)
    await updateStatus("Checkpoint 0: Validating API Key Permissions...");
    try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodedKey}`;
        const testResp = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "ping" }] }]
            })
        });

        if (!testResp.ok) {
            const status = testResp.status;
            const errText = await testResp.text();
            throw new Error(`Test Failed (${status}): ${errText}`);
        }
        console.log("[Background] API Key is valid and working via REST.");
    } catch (testErr: any) {
        console.error(`[Background] API Key Validation Failed: ${testErr.message}`);
        throw new Error(`API Key Rejected by Google in Server Environment. Code: 401/403. CAUSE: Likely 'HTTP Referrer' restrictions in Google Cloud Console. Server requests have no referrer. FIX: Remove restrictions or use a separate Server Key.`);
    }

    // --- 1. INITIALIZE GEMINI UPLOAD ---
    await updateStatus("Checkpoint 1: Initializing Resumable Upload...");
    
    // Explicitly append key to the URL for the handshake
    const handshakeUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodedKey}`;

    const initResp = await fetch(handshakeUrl, {
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
        uploadUrl = `${uploadUrl}${separator}key=${encodedKey}`;
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
        const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
        
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
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream' // Required for binary data
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
            'X-Goog-Upload-Offset': String(uploadOffset),
            'Content-Type': 'application/octet-stream'
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

    // --- 4. WAIT FOR ACTIVE (RAW REST) ---
    await updateStatus("Checkpoint 4: Waiting for File Processing...");
    await waitForFileActive(fileUri, encodedKey);

    // --- 5. GENERATE CONTENT (RAW REST) ---
    await updateStatus("Checkpoint 5: Generating Content...");
    const resultText = await generateContentREST(fileUri, mimeType, mode, model, encodedKey);

    // Save Result
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });
    console.log(`[Background] Job ${jobId} Completed Successfully.`);

  } catch (err: any) {
    console.error(`[Background] FATAL ERROR: ${err.message}`);
    
    // 1. Clean up Error Message
    let errorMessage = err.message;
    try {
        if (errorMessage.startsWith('{')) {
            const jsonErr = JSON.parse(errorMessage);
            errorMessage = jsonErr.error?.message || errorMessage;
        }
    } catch (e) {}

    // 2. Add API Key Debug Info
    const keyPrefix = apiKey ? apiKey.substring(0, 4) : "NONE";
    const keySuffix = apiKey ? apiKey.substring(apiKey.length - 4) : "NONE";
    const keyDebug = `[Key: ${keyPrefix}...${keySuffix}, Len: ${apiKey.length}]`;

    // 3. Construct Final User Message
    const finalError = `${errorMessage} ${keyDebug}`;

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: finalError });
  }
};

async function waitForFileActive(fileUri: string, encodedKey: string) {
    let attempts = 0;
    // fileUri is full URL like https://generativelanguage.googleapis.com/v1beta/files/abc
    // We just need to append the key
    const pollUrl = `${fileUri}?key=${encodedKey}`;

    while (attempts < 60) {
        const r = await fetch(pollUrl);
        
        if (!r.ok) {
             if (r.status === 404) throw new Error("File not found during polling");
             // Retry on temporary errors
        } else {
            const d = await r.json();
            const state = d.state || d.file?.state;
            if (state === 'ACTIVE') return;
            if (state === 'FAILED') throw new Error(`File processing failed state: ${state}`);
        }
        
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error("Timeout waiting for file to become ACTIVE");
}

async function generateContentREST(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are an expert meeting secretary.
    1. Detect the language and write notes in that language.
    2. If silent/noise, return fallback JSON.
    3. Action items must be EXPLICIT tasks only.
    `;

    let taskInstruction = "";
    if (mode === 'TRANSCRIPT_ONLY') taskInstruction = "Transcribe verbatim.";
    else if (mode === 'NOTES_ONLY') taskInstruction = "Create structured notes.";
    else taskInstruction = "Transcribe verbatim AND create structured notes.";

    // Note: REST API uses snake_case for keys
    const payload = {
        contents: [
            {
                parts: [
                    { file_data: { file_uri: fileUri, mime_type: mimeType } },
                    { text: taskInstruction + "\n\nReturn JSON." }
                ]
            }
        ],
        system_instruction: {
            parts: [{ text: systemInstruction }]
        },
        generation_config: {
            response_mime_type: "application/json",
            max_output_tokens: 8192
        }
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Generation Failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    // REST API response structure
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || "{}";
}