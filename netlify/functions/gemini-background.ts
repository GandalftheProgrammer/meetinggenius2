import { Type } from "@google/genai";
import { getStore } from "@netlify/blobs";

// NETLIFY BACKGROUND FUNCTION
// This function runs for up to 15 minutes.
// It receives the request, returns 202 immediately, then continues running.

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
    const { fileUri, mimeType, mode } = payload;
    jobId = payload.jobId;

    if (!jobId || !fileUri) {
        console.error("Missing jobId or fileUri in background payload");
        return;
    }

    console.log(`[Background] Starting job ${jobId} for file ${fileUri}`);

    // Initialize Store
    const store = getStore({ name: "meeting-results", consistency: "strong" });

    // Mark as started
    await store.setJSON(jobId, { status: 'PROCESSING' });

    // FIXED: Using the specific model requested by user
    const MODEL_NAME = "gemini-3-pro-preview"; 

    // --- CONSTRUCT PROMPT ---
      let systemInstruction = `
        You are an expert professional meeting secretary. 
        Listen to the attached audio recording of a meeting.
        
        CRITICAL INSTRUCTION - SILENCE DETECTION:
        Before processing, verify if there is intelligible speech in the audio.
        - If the audio is silent or just noise, output the FALLBACK JSON.
        
        CRITICAL INSTRUCTION - LANGUAGE DETECTION:
        1. Detect the dominant language spoken in the audio.
        2. You MUST write the "summary", "decisions", and "actionItems" in that EXACT SAME LANGUAGE.
        
        CRITICAL INSTRUCTION - ACCURACY & HALLUCINATIONS:
        1. **NO INVENTIONS:** You must NOT invent topics, decisions, or action items that were not explicitly spoken about. If a topic was not discussed, do not include it.
        2. **PROPOSALS VS DECISIONS:** 
           - If a point was proposed/suggested but not explicitly confirmed or agreed upon, you MUST still record it so it is not forgotten, BUT you must phrase it clearly as a "Suggestion" or "Proposal" (e.g., "Proposed: X", "Suggested: Y"). 
           - Only list items as "Decisions" if there was a clear agreement or consensus.
        3. **LITERALNESS:** Stay close to the speakers' actual phrasing. Do not over-interpret vague statements into concrete tasks. If the speaker says "we might look into X", do not write "Action Item: Look into X". Write "Action Item: Evaluate if we should look into X".
        
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
      const decisionsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key decisions and agreed points" };
      const actionItemsSchema = { type: Type.ARRAY, items: { type: Type.STRING }, description: "Action items and suggestions to follow up on" };

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