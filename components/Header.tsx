
import React from 'react';
import { CheckCircle2, Bot, XCircle, ChevronDown } from 'lucide-react';
import { GeminiModel } from '../types';

interface HeaderProps {
  isDriveConnected: boolean;
  onConnectDrive: () => void;
  onDisconnectDrive: () => void;
  selectedModel: GeminiModel;
  onModelChange: (model: GeminiModel) => void;
}

const Header: React.FC<HeaderProps> = ({ 
  isDriveConnected, 
  onConnectDrive, 
  onDisconnectDrive,
  selectedModel,
  onModelChange
}) => {
  return (
    <header className="w-full py-4 md:py-6 px-4 md:px-8 bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-blue-600 shrink-0">
          <div className="p-2 bg-blue-600 rounded-lg shadow-sm">
            <Bot className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-lg md:text-2xl font-bold tracking-tight text-slate-800">
            Meeting<span className="text-blue-600">Genius</span>
          </h1>
        </div>
        <div className="flex items-center gap-2 md:gap-3 overflow-x-auto max-w-full pb-1 md:pb-0">
            <div className="flex relative group shrink-0">
                <div className="flex items-center gap-2 text-xs md:text-sm font-medium text-slate-600 bg-slate-50 px-2 md:px-3 py-1.5 rounded-full border border-slate-200 hover:border-slate-300 transition-colors">
                    <span className="hidden xs:inline">Model:</span>
                    <select 
                        value={selectedModel}
                        onChange={(e) => onModelChange(e.target.value as GeminiModel)}
                        className="bg-transparent outline-none text-slate-800 font-semibold cursor-pointer appearance-none pr-4 max-w-[100px] md:max-w-none text-ellipsis overflow-hidden"
                        style={{ backgroundImage: 'none' }}
                    >
                        <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                        <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                        <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                        <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                        <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                        <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite</option>
                    </select>
                    <ChevronDown className="w-3 h-3 absolute right-2 md:right-3 pointer-events-none text-slate-400" />
                </div>
            </div>
            <button 
                onClick={isDriveConnected ? onDisconnectDrive : onConnectDrive}
                className={`group flex items-center gap-2 px-3 py-1.5 rounded-full text-xs md:text-sm font-medium border transition-all shadow-sm shrink-0 ${
                    isDriveConnected 
                    ? 'bg-green-50 border-green-200 text-green-700 hover:bg-red-50 hover:border-red-200 hover:text-red-600 cursor-pointer' 
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300'
                }`}
                title={isDriveConnected ? "Click to disconnect" : "Connect to Google Drive for auto-saving"}
            >
                {isDriveConnected ? (
                    <>
                        <CheckCircle2 className="w-4 h-4 group-hover:hidden" />
                        <XCircle className="w-4 h-4 hidden group-hover:block" />
                    </>
                ) : (
                    <img 
                        src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" 
                        alt="Google Drive" 
                        className="w-4 h-4"
                    />
                )}
                <span className="hidden sm:inline">
                    {isDriveConnected ? <span className="group-hover:hidden">Connected</span> : 'Drive'}
                    {isDriveConnected && <span className="hidden group-hover:inline">Disconnect</span>}
                </span>
            </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
