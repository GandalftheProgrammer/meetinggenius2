
export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED', // Has data, can resume or process
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export type ProcessingMode = 'ALL' | 'NOTES_ONLY' | 'TRANSCRIPT_ONLY';

export type GeminiModel = 
  | 'gemini-3-pro-preview'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite-preview-02-05'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-flash';

export interface MeetingData {
  transcription: string;
  summary: string;
  conclusions: string[]; // Renamed from decisions to allow for broader insights
  actionItems: string[];
}

export interface ProcessedResult {
  transcriptionMarkdown: string;
  notesMarkdown: string;
}

export interface GoogleUser {
  access_token: string;
  expires_in: number;
}
