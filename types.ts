
export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED', // Has data, can resume or process
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export type ProcessingMode = 'ALL' | 'NOTES_ONLY' | 'TRANSCRIPT_ONLY';

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
