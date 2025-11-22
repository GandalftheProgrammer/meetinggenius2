import { MeetingData, ProcessingMode } from '../types';

// NOTE: In this SaaS architecture, the Client NO LONGER needs the GoogleGenAI SDK directly
// because all "thinking" happens on the backend.
// We only keep the Types/Interfaces here if needed, or just plain fetch calls.

export const processMeetingAudio = async (
  audioBlob: Blob, 
  mimeType: string, 
  mode: ProcessingMode = 'ALL'
): Promise<MeetingData> => {
  try {
    console.log(`Starting SaaS Flow. Blob size: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

    // --- STEP 1: HANDSHAKE (Authorize Upload) ---
    // Ask our backend for a secure Google Upload URL. 
    // We don't send the file yet, just the metadata.
    console.log("Step 1: Requesting Upload URL from backend...");
    const authResponse = await fetch('/.netlify/functions/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'authorize_upload',
        mimeType: mimeType,
        fileSize: audioBlob.size.toString()
      })
    });

    if (!authResponse.ok) {
      const err = await authResponse.text();
      throw new Error(`Backend Handshake Failed: ${err}`);
    }

    const { uploadUrl } = await authResponse.json();
    console.log("Step 1 Complete. Received secure upload URL.");

    // --- STEP 2: DIRECT UPLOAD (Browser -> Google) ---
    // Upload the raw binary directly to Google's servers using the URL we just got.
    // This bypasses Netlify's 6MB limit.
    console.log("Step 2: Uploading raw data to Google...");
    
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST', // Google Resumable protocol uses POST/PUT with specific headers
      headers: {
        'Content-Length': audioBlob.size.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: audioBlob
    });

    if (!uploadResponse.ok) {
      throw new Error(`Direct Upload Failed: ${uploadResponse.statusText}`);
    }

    const uploadResult = await uploadResponse.json();
    const fileUri = uploadResult.file.uri;
    console.log(`Step 2 Complete. File URI: ${fileUri}`);

    // --- STEP 3: GENERATE (Trigger AI) ---
    // Now tell the backend: "The file is ready at this URI, please process it."
    console.log("Step 3: Requesting generation from backend...");
    
    const generateResponse = await fetch('/.netlify/functions/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'generate',
            fileUri: fileUri,
            mimeType: uploadResult.file.mimeType,
            mode: mode
        })
    });
    
    if (!generateResponse.ok) {
       const err = await generateResponse.text();
       throw new Error(`Generation Failed: ${err}`);
    }

    const result = await generateResponse.json();
    console.log("Step 3 Complete. Data received.");
    
    return parseResponse(result.text, mode);

  } catch (error) {
    console.error("Error in SaaS flow:", error);
    throw error;
  }
};

// Helper to normalize partial data
function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    try {
        const rawData = JSON.parse(jsonText);
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            decisions: rawData.decisions || [],
            actionItems: rawData.actionItems || [],
        };
    } catch (e) {
        console.error("Failed to parse JSON from AI", jsonText);
        return {
            transcription: "Error parsing response",
            summary: "Error parsing response",
            decisions: [],
            actionItems: []
        };
    }
}