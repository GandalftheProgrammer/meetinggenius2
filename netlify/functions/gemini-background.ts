import { Type } from "@google/genai";
import { getStore } from "@netlify/blobs";

// NETLIFY BACKGROUND FUNCTION
// This function runs for up to 15 minutes.
// It receives the request, returns 202 immediately, then continues running.

const waitForFileActive = async (fileUri: string, apiKey: string) => {
    console.log(`[Background] Checking state for ${fileUri}...`);
    let attempts = 0;
    const maxAttempts = 180; // Increased to 15 minutes max (180 * 5s)

    while (attempts < maxAttempts) {
        try {
            const response = await fetch(`${fileUri}?key=${apiKey}`);
            if (!response.ok) throw new Error(`Failed to fetch file status: ${response.statusText}`);
            
            const data = await response.json();
            
            if (data.state === "ACTIVE") {
                console.log(`[Background] File ${fileUri} is ACTIVE (Attempt ${attempts}).`);
                return;
            }
            
            if (data.state === "FAILED") {
                throw new Error("File processing failed on Google side.");
            }

            console.log(`[Background] File state is ${data.state}, waiting 5s...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        } catch (e) {
            console.warn(`[Background] Error checking file state: ${e}`);
            // Wait and retry even on network error, unless max attempts reached
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
    }
    throw new Error(`Timeout waiting for file to become ACTIVE. Attempts: ${attempts}`);
};

export default async (req: Request) => {
  // If this is a preflight or non-POST, ignore
  if (req.method !== 'POST') return new Response("OK");

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
      console.error("API_KEY missing in background function");
      return;
  }

  let jobId: string = "";

  try {
    const payload = await req.json();
    const { fileUri, mimeType, mode, model } = payload;
    jobId = payload.jobId;

    if (!jobId || !fileUri) {
        console.error("Missing jobId or fileUri in background payload");
        return;
    }

    // Use selected model or fallback to 3-pro-preview
    const MODEL_NAME = model || "gemini-3-pro-preview";

    console.log(`[Background] Starting job ${jobId} for file ${fileUri} using model ${MODEL_NAME}`);

    // Initialize Store
    const store = getStore({ name: "meeting-results", consistency: "strong" });

    // Mark as started
    await store.setJSON(jobId, { status: 'PROCESSING' });

    // --- WAIT FOR FILE PROCESSING ---
    try {
        await waitForFileActive(fileUri, apiKey);
    } catch (fileError: any) {
        console.error(`[Background] File Error: ${fileError.message}`);
        await store.setJSON(jobId, { status: 'ERROR', error: `File Processing Error: ${fileError.message}` });
        return;
    }

    // --- CONSTRUCT PROMPT ---
      let systemInstruction = `
        You are an expert professional meeting secretary. 
        Listen to the attached audio recording of a meeting.
        
        CRITICAL INSTRUCTION - SILENCE DETECTION:
        Before processing, verify if there is intelligible speech in the audio.
        - If the audio is silent or just noise, output the FALLBACK JSON.
        
        CRITICAL INSTRUCTION - LANGUAGE DETECTION:
        1. Detect the dominant language spoken in the audio.
        2. You MUST write the "summary", "conclusions", and "actionItems" in that EXACT SAME LANGUAGE.
        
        CRITICAL INSTRUCTION - ACCURACY & HALLUCINATIONS:
        
        1. **CONCLUSIONS & INSIGHTS (Flexible):** 
           - For the "conclusions" section, you are allowed to be intelligent.
           - Identify key decisions, consensus reached, and overarching insights.
           - You may synthesize implied conclusions even if they weren't stated as a formal "motion".
           - Focus on the *outcome* of discussions.

        2. **ACTION ITEMS (STRICT & LITERAL):** 
           - For the "actionItems" section, you must be EXTREMELY STRICT.
           - **NO INVENTIONS:** Do not create tasks that "make sense" but weren't said.
           - **EXPLICIT ONLY:** Only list an action item if someone proposed it or agreed to it explicitly (e.g., "I will do X", "Let's check Y").
           - **LITERAL PHRASING:** Use the literal wording of the task as much as possible. Do not interpret "We should probably think about marketing" as "Action: Create full marketing plan". Instead write: "Action: Consider thinking about marketing".
           - **PROPOSALS:** If something is proposed but not confirmed, list it as "Proposed: [Task]".
        
        FALLBACK JSON (Only if silence):
        {
            "transcription": "[No intelligible speech detected]",
            "summary": "No conversation was detected in the audio recording.",
            "conclusions": [],
            "actionItems": []
        }
      `;

      let taskInstruction = "";
      const transcriptionSchema = { type: Type.STRING, description: "Full verbatim transcription" };
      const summarySchema = { type: Type.STRING, description: "A concise summary" };
      
      // Changed from decisions to conclusions
      const conclusionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key conclusions, decisions, and insights from the meeting" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Strictly explicitly agreed tasks or proposals" };

      let schemaProperties: any = {};
      let requiredFields: string[] = [];

      if (mode === 'TRANSCRIPT_ONLY') {
        taskInstruction = "Your task is to Transcribe the audio verbatim. Do not generate summary or notes.";
        schemaProperties = { transcription: transcriptionSchema };
        requiredFields = ["transcription"];
      } else if (mode === 'NOTES_ONLY') {
        taskInstruction = "Your task is to create structured meeting notes.";
        schemaProperties = { summary: summarySchema, conclusions: conclusionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["summary", "conclusions", "actionItems"];
      } else {
        taskInstruction = "Your task is to Transcribe the audio verbatim AND create structured meeting notes.";
        schemaProperties = { transcription: transcriptionSchema, summary: summarySchema, conclusions: conclusionsSchema, actionItems: actionItemsSchema };
        requiredFields = ["transcription", "summary", "conclusions", "actionItems"];
      }

      const requestBody = {
        contents: [
           { 
             parts: [
               { fileData: { fileUri: fileUri, mimeType: mimeType } },
               { text: systemInstruction + "\n\n" + taskInstruction + "\n\nReturn the output strictly in JSON format." }
             ]
           }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: schemaProperties,
                required: requiredFields,
            },
        }
      };

    // --- CALL GOOGLE ---
    console.log(`[Background] Calling Gemini (${MODEL_NAME}) for ${jobId}...`);
    
    const googleResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`, 
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
        }
    );

    if (!googleResponse.ok) {
        const err = await googleResponse.text();
        console.error(`[Background] Gemini Error: ${err}`);
        await store.setJSON(jobId, { status: 'ERROR', error: `Gemini API Error: ${err}` });
        return;
    }

    const jsonResponse = await googleResponse.json();
    
    // Extract text from the candidate
    let fullText = "";
    if (jsonResponse.candidates && 
        jsonResponse.candidates[0] && 
        jsonResponse.candidates[0].content && 
        jsonResponse.candidates[0].content.parts) {
        
        jsonResponse.candidates[0].content.parts.forEach((part: any) => {
            if (part.text) fullText += part.text;
        });
    }

    if (!fullText) {
        await store.setJSON(jobId, { status: 'ERROR', error: "Model returned empty response" });
        return;
    }

    // --- SUCCESS: SAVE TO BLOB ---
    console.log(`[Background] Job ${jobId} success. Saving to blob.`);
    await store.setJSON(jobId, { status: 'COMPLETED', result: fullText });

  } catch (err: any) {
    console.error(`[Background] Crash in job ${jobId}:`, err);
    if (jobId) {
        const store = getStore({ name: "meeting-results", consistency: "strong" });
        await store.setJSON(jobId, { status: 'ERROR', error: err.message });
    }
  }
};