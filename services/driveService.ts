
import { GoogleUser } from '../types';

// This relies on the Google Identity Services script loaded in index.html
declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;

// Initialize the Drive Client
export const initDrive = (callback: (token: string) => void) => {
  if (typeof google === 'undefined') {
    console.error('Google Identity Services script not loaded');
    return;
  }

  // Vite uses import.meta.env for environment variables
  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        // Store expiration time to manage session locally if needed
        const expiresIn = tokenResponse.expires_in; 
        const expiresAt = Date.now() + expiresIn * 1000;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', expiresAt.toString());
        callback(accessToken);
      }
    },
  });

  // Check for existing valid token
  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < parseInt(expiry)) {
    accessToken = storedToken;
    callback(storedToken);
  }
};

export const connectToDrive = () => {
  if (!tokenClient) {
    console.error("Drive client not initialized");
    return;
  }
  // Force the user to select an account to avoid confusion about which Drive is connected
  // 'consent' ensures the user approves permissions again (useful for testing)
  // 'select_account' forces the account chooser
  tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  accessToken = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  if (typeof google !== 'undefined') {
    google.accounts.oauth2.revoke(accessToken, () => { console.log('Token revoked') });
  }
};

// Helper to get or create a folder ID based on name
const getFolderId = async (folderName: string): Promise<string | null> => {
  if (!accessToken) return null;

  const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  const data = await response.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  return null;
};

const createFolder = async (folderName: string): Promise<string> => {
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };

  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });
  const data = await response.json();
  return data.id;
};

// Upload function that retrieves the preferred folder name from storage if not passed
export const uploadToDrive = async (filename: string, content: string): Promise<{id: string, webViewLink?: string}> => {
  if (!accessToken) throw new Error("Not authenticated");

  // Retrieve folder preference, default to 'MeetingGenius'
  const folderName = localStorage.getItem('drive_folder_name') || 'MeetingGenius';

  // 1. Find or Create Folder
  let folderId = await getFolderId(folderName);
  if (!folderId) {
    folderId = await createFolder(folderName);
  }

  // 2. Upload File
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: 'text/markdown',
  };

  const fileContent = new Blob([content], { type: 'text/markdown' });
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileContent);

  // Request 'webViewLink' field to allow opening the file later
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!response.ok) throw new Error("Upload failed");
  const data = await response.json();
  return { id: data.id, webViewLink: data.webViewLink };
};
