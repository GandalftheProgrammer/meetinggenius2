
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// NETLIFY BACKGROUND FUNCTION
// Reads chunks from storage, stitches them to 8MB, uploads to Gemini via REST API, and processes.

// Define smart fallback sequences for models to handle 503 Overloads
const FALLBACK_CHAINS: Record<string, string[]> = {
    'gemini-3-pro-preview': ['gemini-3-pro-preview', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-pro': ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-flash': ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.5-flash-lite': ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'],
    'gemini-2.0-flash': ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.0-flash-lite': ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
};

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

    // --- 5. GENERATE CONTENT (RAW REST WITH SMART FALLBACK) ---
    await updateStatus("Checkpoint 5: Generating Content...");
    
    // Determine the chain of models to try
    const modelsToTry = FALLBACK_CHAINS[model] || [model];
    let resultText = "";
    let generationSuccess = false;

    console.log(`[Background] Model Strategy: ${modelsToTry.join(' -> ')}`);

    for (const currentModel of modelsToTry) {
        try {
            if (currentModel !== model) {
                console.log(`[Background] Switching to fallback model: ${currentModel}`);
            }
            resultText = await generateContentREST(fileUri, mimeType, mode, currentModel, encodedKey);
            generationSuccess = true;
            break; // Success! Exit fallback loop
        } catch (e: any) {
            console.warn(`[Background] Failed with model ${currentModel}: ${e.message}`);
            // Check if error is transient (503/429) to decide whether to continue chain
            if (e.message.includes('503') || e.message.includes('429')) {
                continue; // Try next model
            }
            throw e; // Fatal error (e.g. 400 Invalid Argument), don't try other models
        }
    }

    if (!generationSuccess) {
        throw new Error(`Generation failed with all attempted models: ${modelsToTry.join(', ')}`);
    }

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

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: errorMessage });
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

async function generateContentREST(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are an expert meeting secretary.
    1. CRITICAL: Analyze the audio to detect the primary spoken language.
    2. CRITICAL: All output (transcription, summary, conclusions, action items) MUST be written in the DETECTED LANGUAGE. Do not translate to English unless the audio is in English.
    3. If the audio is silent or contains only noise, return a valid JSON with empty fields.
    4. Action items must be EXPLICIT tasks only assigned to specific people if mentioned.
    5. The Summary must be DETAILED and COMPREHENSIVE. Do not over-summarize; capture the nuance of the discussion, key arguments, and context.
    6. Conclusions & Insights should be extensive, capturing all decisions, agreed points, and important observations made during the meeting.
    
    STRICT OUTPUT FORMAT:
    You MUST return a raw JSON object (no markdown code blocks) with the following schema:
    {
      "transcription": "The full verbatim transcript...",
      "summary": "A detailed and comprehensive summary of the meeting...",
      "conclusions": ["Detailed conclusion 1", "Detailed insight 2", "Decision 3"],
      "actionItems": ["Task 1", "Task 2"]
    }
    `;

    let taskInstruction = "";
    if (mode === 'TRANSCRIPT_ONLY') taskInstruction = "Transcribe the audio verbatim in the spoken language. Leave summary/conclusions/actionItems empty.";
    else if (mode === 'NOTES_ONLY') taskInstruction = "Create detailed structured notes (summary, conclusions, actionItems) in the spoken language. Leave transcription empty.";
    else taskInstruction = "Transcribe the audio verbatim AND create detailed structured notes in the spoken language.";

    const payload = {
        contents: [
            {
                parts: [
                    { file_data: { file_uri: fileUri, mime_type: mimeType } },
                    { text: taskInstruction + "\n\nReturn strict JSON." }
                ]
            }
        ],
        system_instruction: {
            parts: [{ text: systemInstruction }]
        },
        generation_config: {
            response_mime_type: "application/json",
            max_output_tokens: 8192
        },
        // SAFETY SETTINGS: DISABLE ALL FILTERS to prevent empty responses on informal speech
        safety_settings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    // Retry Loop for 503/429 Errors for a SINGLE model
    // We limit this to 2 retries per model to ensure we failover to the next model in the chain quickly
    let attempts = 0;
    const maxRetries = 2;
    
    while (attempts <= maxRetries) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (resp.ok) {
                const data = await resp.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                // If model returns nothing (due to safety or error), default to empty JSON to prevent parser crashes
                if (!text) {
                    console.warn(`[Background] Model returned empty text. FinishReason: ${data.candidates?.[0]?.finishReason}`);
                    return "{}";
                }
                return text;
            }

            // Handle Retriable Errors
            if (resp.status === 503 || resp.status === 429) {
                attempts++;
                if (attempts > maxRetries) {
                    throw new Error(`Model ${model} Overloaded (503)`);
                }
                
                const delay = 1000 * attempts; // Fast retry: 1s, 2s
                console.warn(`[Background] ${model} Overloaded (${resp.status}). Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // Fatal Error
            const errText = await resp.text();
            throw new Error(`Generation Failed (${resp.status}): ${errText}`);

        } catch (e: any) {
            // Re-throw if it's our own status error
            if (e.message.includes("Overloaded") || e.message.includes("Generation Failed")) throw e;
            
            attempts++;
            if (attempts > maxRetries) throw e;
            
            console.warn(`[Background] Network Error with ${model}: ${e.message}. Retrying...`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    throw new Error("Unexpected loop exit");
}
