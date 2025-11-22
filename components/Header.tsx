
import React from 'react';
import { Mic, Sparkles, CheckCircle2 } from 'lucide-react';

interface HeaderProps {
  isDriveConnected: boolean;
  onConnectDrive: () => void;
}

const GoogleDriveIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 87.3 78" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.9 2.5 3.2 3.3l12.3-21.3-6.5-11.3-12.85 22.65c-.7 1.3-.8 2.85-.3 4.3.4 1.5 1.3 2.8 2.55 3.8z" fill="#0066da"/>
    <path d="m43.65 25-12.3-21.3c-1.3.8-2.4 1.9-3.2 3.3l-12.85 22.3c-1.1 1.9-1.1 4.2 0 6.1l12.85 22.3c.8 1.4 1.9 2.5 3.2 3.3l12.85-22.3 6.05-10.5-6.6-11.3z" fill="#00ac47"/>
    <path d="m73.55 76.8c1.9 0 3.75-.5 5.35-1.45 1.6-.95 2.9-2.25 3.8-3.8l3.85-6.65a10 10 0 0 0 .3-4.3 10 10 0 0 0-2.55-3.8l-6.05-10.5-12.85 22.3-6.5 11.3 14.65 6.9z" fill="#ea4335"/>
    <path d="m43.65 25 12.85-22.3c-1.1-1.9-1.1-4.2 0-6.1l-12.85-22.3c-.8-1.4-1.9-2.5-3.2-3.3l-12.85 22.3 6.05 10.5 6.6 11.3z" fill="#ffba00"/>
  </svg>
);

const Header: React.FC<HeaderProps> = ({ isDriveConnected, onConnectDrive }) => {
  return (
    <header className="w-full py-6 px-4 md:px-8 bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2 text-blue-600">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Mic className="w-6 h-6" />
          </div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-slate-800">
            Meeting<span className="text-blue-600">Genius</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-3">
            <button 
                onClick={onConnectDrive}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border transition-all shadow-sm ${
                    isDriveConnected 
                    ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100' 
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
                title={isDriveConnected ? "Connected to Google Drive" : "Connect to Google Drive to save notes automatically"}
            >
                {isDriveConnected ? <CheckCircle2 className="w-4 h-4" /> : <GoogleDriveIcon className="w-4 h-4" />}
                <span className="hidden md:inline">{isDriveConnected ? 'Drive Connected' : 'Connect to Google Drive'}</span>
            </button>

            <div className="hidden md:flex items-center gap-1 text-sm font-medium text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                <Sparkles className="w-4 h-4 text-purple-500" />
                <span>Gemini 3</span>
            </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
