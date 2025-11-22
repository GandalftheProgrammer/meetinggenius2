
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { model, contents, config } = JSON.parse(event.body);

    // In a real production app, you might want to validate the user here
    // e.g., verify a Firebase token or Auth0 session.

    const response = await ai.models.generateContent({
      model,
      contents,
      config
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ text: response.text }),
      headers: {
        'Content-Type': 'application/json'
      }
    };

  } catch (error: any) {
    console.error('Gemini Proxy Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
