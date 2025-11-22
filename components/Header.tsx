
import React from 'react';
import { Mic, Sparkles, HardDrive, CheckCircle2 } from 'lucide-react';

interface HeaderProps {
  isDriveConnected: boolean;
  onConnectDrive: () => void;
}

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
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                    isDriveConnected 
                    ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100' 
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
                title={isDriveConnected ? "Connected to Google Drive" : "Connect to Google Drive to save notes automatically"}
            >
                {isDriveConnected ? <CheckCircle2 className="w-4 h-4" /> : <HardDrive className="w-4 h-4" />}
                <span className="hidden md:inline">{isDriveConnected ? 'Drive Connected' : 'Connect Drive'}</span>
            </button>

            <div className="hidden md:flex items-center gap-1 text-sm font-medium text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                <Sparkles className="w-4 h-4 text-purple-500" />
                <span>Powered by Gemini 3</span>
            </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
