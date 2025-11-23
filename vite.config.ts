import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // We only inject the API Key in 'development' mode (npm run dev / AI Studio).
  // In 'production' (Netlify), this will be undefined, forcing the app to use the Backend Proxy.
  const isDev = mode === 'development';

  return {
    plugins: [react()],
    define: {
      // This allows 'import.meta.env.VITE_GEMINI_API_KEY' to work in Dev
      // while ensuring it is removed from the Production build.
      'import.meta.env.VITE_GEMINI_API_KEY': isDev ? JSON.stringify(process.env.API_KEY) : undefined
    }
  };
});