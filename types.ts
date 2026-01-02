
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
  | 'gemini-3-flash-preview'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite';

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
