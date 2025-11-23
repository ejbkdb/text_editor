import React, { useState, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import axios from 'axios';
import { 
  Search, Save, CheckCircle, Circle, FileCode, 
  AlertTriangle, ChevronDown, ChevronUp, X, ArrowRight 
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Config ---
const API = 'http://127.0.0.1:3000/api';

// --- Types ---
type Status = 'todo' | 'in_progress' | 'done';

interface SearchResult {
  file: string;
  line: number;
  column: number;
  preview: string;
}

interface ChecklistItem {
  status: Status;
  note: string;
  updated_ts: number;
}

interface FileData {
  path: string;
  content: string;
  etag: string;
}

// --- Components ---

function Badge({ status }: { status: Status }) {
  if (status === 'done') return <span className="text-xs bg-green-900 text-green-300 px-1.5 py-0.5 rounded flex items-center gap-1"><CheckCircle size={10}/> Done</span>;
  if (status === 'in_progress') return <span className="text-xs bg-blue-900 text-blue-300 px-1.5 py-0.5 rounded flex items-center gap-1"><Circle size={10}/> In Prog</span>;
  return null;
}

function App() {
  // --- State ---
  const [query, setQuery] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  
  // Raw Data
  const [rawResults, setRawResults] = useState<SearchResult[]>([]);
  const [checklist, setChecklist] = useState<Record<string, ChecklistItem>>({});
  
  // Editor State
  const [activeFile, setActiveFile] = useState<FileData | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [unsavedChanges, setUnsavedChanges] = useState(false);
  
  // UI State
  const [sidebarWidth] = useState(350);
  const [statusMsg, setStatusMsg] = useState<{type: 'info'|'error'|'success', text: string} | null>(null);

  // Monaco Refs
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const decorationsCollection = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  // --- Derived State ---
  
  const fileList = useMemo(() => {
    const groups: Record<string, { count: number, firstLine: number, status: Status }> = {};
    
    // 1. Process Search Results
    rawResults.forEach(r => {
      if (!groups[r.file]) {
        groups[r.file] = { 
          count: 0, 
          firstLine: r.line, 
          status: checklist[r.file]?.status || 'todo' 
        };
      }
      groups[r.file].count++;
    });

    // 2. Fallback to checklist items if search is empty and no results
    if (rawResults.length === 0 && query === '') {
      Object.keys(checklist).forEach(path => {
        groups[path] = { count: 0, firstLine: 1, status: checklist[path].status };
      });
    }

    return Object.entries(groups).map(([path, data]) => ({ path, ...data }));
  }, [rawResults, checklist, query]);

  // --- API Actions ---

  const refreshChecklist = async () => {
    try {
      const res = await axios.get(`${API}/checklist`);
      setChecklist(res.data);
    } catch (e) { console.error(e); }
  };

  const runSearch = async (q: string = query) => {
    setIsSearching(true);
    try {
      if (!q.trim()) {
        setRawResults([]);
        setIsSearching(false);
        return;
      }
      const res = await axios.get(`${API}/search`, { params: { q, regex: isRegex } });
      setRawResults(res.data);
    } catch (e) {
      setStatusMsg({ type: 'error', text: 'Search failed' });
    } finally {
      setIsSearching(false);
    }
  };

  const openFile = async (path: string, line?: number) => {
    if (unsavedChanges) {
      if (!confirm("You have unsaved changes. Discard them?")) return;
    }

    try {
      const res = await axios.get(`${API}/file`, { params: { path } });
      const data = { path, content: res.data.content, etag: res.data.etag };
      setActiveFile(data);
      setEditorContent(data.content);
      setUnsavedChanges(false);

      const currentStatus = checklist[path]?.status || 'todo';
      if (currentStatus === 'todo') {
        handleSetStatus(path, 'in_progress');
      }

      // Wait for editor to render before highlighting/scrolling
      setTimeout(() => {
        highlightMatches(query, isRegex);
        if (line && editorRef.current) {
            editorRef.current.revealLineInCenter(line);
            editorRef.current.setPosition({ lineNumber: line, column: 1 });
            editorRef.current.focus();
        }
      }, 100);

    } catch (e) {
      setStatusMsg({ type: 'error', text: 'Could not open file' });
    }
  };

  const handleSave = async (): Promise<boolean> => {
    if (!activeFile) return false;
    try {
      const res = await axios.post(`${API}/file`, {
        path: activeFile.path,
        content: editorContent,
        etag: activeFile.etag
      });

      if (res.data.status === 'conflict') {
        alert("CONFLICT: File changed on disk. Reload required.");
        return false;
      }

      setActiveFile({ ...activeFile, content: editorContent, etag: res.data.new_etag });
      setUnsavedChanges(false);
      setStatusMsg({ type: 'success', text: 'Saved successfully' });
      
      if (query) runSearch();
      return true;

    } catch (e) {
      setStatusMsg({ type: 'error', text: 'Save failed' });
      return false;
    }
  };

  const handleSaveAndNext = async () => {
    // 1. Determine next file immediately
    const currentIndex = fileList.findIndex(f => f.path === activeFile?.path);
    let nextFile = null;
    if (currentIndex !== -1 && currentIndex < fileList.length - 1) {
        nextFile = fileList[currentIndex + 1];
    }

    // 2. Save if dirty
    if (unsavedChanges) {
      const success = await handleSave();
      if (!success) return; // Stop if save failed
    }

    // 3. Navigate
    if (nextFile) {
        openFile(nextFile.path, nextFile.firstLine);
    } else {
        setStatusMsg({ type: 'info', text: 'End of list' });
    }
  };

  // Keep ref updated for Monaco shortcuts
  const handleSaveAndNextRef = useRef(handleSaveAndNext);
  useEffect(() => { handleSaveAndNextRef.current = handleSaveAndNext; }, [handleSaveAndNext]);

  const handleSetStatus = async (path: string, status: Status) => {
    setChecklist(prev => ({
      ...prev,
      [path]: { ...prev[path], status, note: prev[path]?.note || '', updated_ts: Date.now() }
    }));

    await axios.patch(`${API}/checklist`, { path, status });
    refreshChecklist();
  };

  // --- Editor Logic ---

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorationsCollection.current = editor.createDecorationsCollection([]);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave();
    });

    // Alt+N for Save & Next
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyN, () => {
        handleSaveAndNextRef.current();
    });
    
    // Alt+D to mark done
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyD, () => {
        if(activeFile) handleSetStatus(activeFile.path, 'done');
    });
  };

  const highlightMatches = (searchTerm: string, regexMode: boolean) => {
    if (!editorRef.current || !monacoRef.current || !searchTerm) return;
    
    const model = editorRef.current.getModel();
    if (!model) return;

    try {
        const matches = model.findMatches(
            searchTerm,
            false, 
            regexMode, 
            false, 
            null, 
            true 
        );

        const decorations = matches.map((m) => ({
            range: m.range,
            options: {
                isWholeLine: false,
                className: 'bg-yellow-900/50 border-b-2 border-orange-500 text-white',
                minimap: { color: '#f97316', position: 1 }
            }
        }));

        if (decorationsCollection.current) {
            decorationsCollection.current.set(decorations);
        }
    } catch(e) {
        console.warn("Invalid regex or search error");
    }
  };

  // --- Effects ---

  useEffect(() => { refreshChecklist(); }, []);

  // --- Render ---

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      
      {/* HEADER */}
      <div className="h-14 bg-[#1e1e1e] border-b border-[#333] flex items-center px-4 shrink-0 gap-4">
        <div className="font-bold text-orange-500 flex items-center gap-2 select-none">
          <FileCode size={20} /> CodeEdit
        </div>
        
        <div className="flex-1 max-w-2xl relative">
          <div className="absolute inset-y-0 left-2 flex items-center pointer-events-none">
            <Search size={16} className="text-gray-500"/>
          </div>
          <input 
            className="w-full bg-[#2d2d2d] border border-[#3e3e3e] text-sm text-white rounded-md py-1.5 pl-8 pr-20 focus:outline-none focus:border-blue-500 transition-colors placeholder-gray-500"
            placeholder="Search..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
          />
          <div className="absolute inset-y-0 right-2 flex items-center gap-2">
            <label className="text-xs text-gray-400 flex items-center gap-1 cursor-pointer hover:text-white select-none">
              <input type="checkbox" checked={isRegex} onChange={e => setIsRegex(e.target.checked)} />
              .*
            </label>
          </div>
        </div>

        <button 
            onClick={() => runSearch()} 
            disabled={isSearching}
            className="bg-blue-700 hover:bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        >
            {isSearching ? '...' : 'Search'}
        </button>
      </div>

      {/* MAIN BODY */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* SIDEBAR */}
        <div style={{ width: sidebarWidth }} className="bg-[#252526] border-r border-[#333] flex flex-col shrink-0">
          <div className="p-2 text-xs font-bold text-gray-400 uppercase tracking-wider flex justify-between items-center select-none">
            <span>Files ({fileList.length})</span>
            <button onClick={refreshChecklist} className="hover:text-white">↺</button>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            {fileList.map((file) => (
              <div 
                key={file.path}
                onClick={() => openFile(file.path, file.firstLine)}
                className={cn(
                  "px-3 py-2 border-b border-[#2d2d2d] cursor-pointer group transition-colors",
                  activeFile?.path === file.path ? "bg-[#37373d] border-l-2 border-l-blue-500" : "hover:bg-[#2a2d2e]"
                )}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="text-sm font-medium text-gray-200 break-all leading-tight">
                    {file.path}
                  </span>
                  {file.count > 0 && (
                    <span className="text-xs bg-[#333] text-gray-400 px-1.5 rounded-full shrink-0 ml-2">
                      {file.count}
                    </span>
                  )}
                </div>
                <div className="flex justify-between items-center mt-1 h-5">
                   <Badge status={file.status} />
                   
                   <div className={cn("flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity", activeFile?.path === file.path && "opacity-100")}>
                     <button 
                       title="Todo"
                       onClick={(e) => { e.stopPropagation(); handleSetStatus(file.path, 'todo'); }}
                       className="p-1 hover:bg-gray-600 rounded text-gray-400 hover:text-white"
                     ><Circle size={12}/></button>
                     <button 
                       title="Done"
                       onClick={(e) => { e.stopPropagation(); handleSetStatus(file.path, 'done'); }}
                       className="p-1 hover:bg-gray-600 rounded text-green-500 hover:text-green-300"
                     ><CheckCircle size={12}/></button>
                   </div>
                </div>
              </div>
            ))}
            {fileList.length === 0 && (
              <div className="p-8 text-center text-gray-500 text-sm select-none">
                No files. Search or edit checklist.
              </div>
            )}
          </div>
        </div>

        {/* EDITOR AREA */}
        <div className="flex-1 flex flex-col bg-[#1e1e1e] relative">
          {activeFile ? (
            <>
              {/* Toolbar */}
              <div className="h-9 bg-[#1e1e1e] border-b border-[#333] flex items-center justify-between px-4 select-none">
                <div className="text-sm text-gray-300 flex items-center gap-2">
                  <FileCode size={14} className="text-blue-400"/>
                  {activeFile.path}
                  {unsavedChanges && <span className="text-xs text-yellow-500 ml-2">● Unsaved</span>}
                </div>
                
                <div className="flex items-center gap-2">
                  {checklist[activeFile.path]?.status !== 'done' ? (
                    <button 
                      onClick={() => handleSetStatus(activeFile.path, 'done')}
                      className="flex items-center gap-1 text-xs bg-green-900/80 text-green-100 px-2 py-1 rounded hover:bg-green-800 transition-colors"
                    >
                      <CheckCircle size={12} /> Mark Done
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleSetStatus(activeFile.path, 'in_progress')}
                      className="flex items-center gap-1 text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded hover:bg-gray-600"
                    >
                      Reopen
                    </button>
                  )}
                  
                  <div className="w-px h-3 bg-gray-700 mx-2"></div>

                  <button 
                    onClick={handleSaveAndNext}
                    className="flex items-center gap-1 text-xs bg-blue-800 text-white px-3 py-1 rounded hover:bg-blue-700 transition-colors"
                    title="Save and go to next file (Alt+N)"
                  >
                    <Save size={12} /> <ArrowRight size={12} /> Save & Next
                  </button>

                  <button 
                    onClick={() => handleSave()}
                    disabled={!unsavedChanges}
                    className="flex items-center gap-1 text-xs bg-gray-700 text-white px-3 py-1 rounded hover:bg-gray-600 disabled:opacity-50 disabled:hover:bg-gray-700 transition-colors"
                    title="Ctrl+S"
                  >
                    <Save size={12} />
                  </button>
                </div>
              </div>

              {/* Monaco */}
              <div className="flex-1 relative">
                 <Editor
                    height="100%"
                    theme="vs-dark"
                    path={activeFile.path}
                    value={editorContent}
                    onChange={(val) => {
                      setEditorContent(val || '');
                      setUnsavedChanges(true);
                    }}
                    onMount={handleEditorMount}
                    options={{
                      fontSize: 14,
                      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                      minimap: { enabled: true },
                      scrollBeyondLastLine: false,
                      renderWhitespace: 'selection',
                      smoothScrolling: true,
                      padding: { top: 16, bottom: 16 }
                    }}
                 />
              </div>
              
              {/* Search Nav Footer */}
              {query && (
                <div className="h-7 bg-[#007acc] text-white flex items-center px-4 justify-between text-xs select-none">
                  <span>
                    Matches for: <strong>{query}</strong> 
                  </span>
                  <div className="flex items-center gap-1">
                    <button 
                      className="hover:bg-white/20 p-0.5 rounded"
                      onClick={() => editorRef.current?.trigger('source', 'editor.action.nextMatchFindAction')}
                      title="Next Match (F3)"
                    >
                      <ChevronDown size={16}/>
                    </button>
                    <button 
                      className="hover:bg-white/20 p-0.5 rounded"
                      onClick={() => editorRef.current?.trigger('source', 'editor.action.previousMatchFindAction')}
                      title="Previous Match (Shift+F3)"
                    >
                      <ChevronUp size={16}/>
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-4 select-none">
              <FileCode size={64} strokeWidth={1} className="opacity-20" />
              <p>Select a file from the sidebar.</p>
            </div>
          )}

          {/* Notifications */}
          {statusMsg && (
             <div className={cn(
               "absolute bottom-10 right-10 px-4 py-2 rounded shadow-lg text-sm font-medium flex items-center gap-2 animate-in slide-in-from-bottom-2 fade-in duration-300 z-50",
               statusMsg.type === 'error' ? "bg-red-900 text-white" : 
               statusMsg.type === 'success' ? "bg-green-900 text-white" : "bg-blue-900 text-white"
             )}>
               {statusMsg.type === 'error' ? <AlertTriangle size={16}/> : <CheckCircle size={16}/>}
               {statusMsg.text}
               <button onClick={() => setStatusMsg(null)} className="ml-2 opacity-50 hover:opacity-100"><X size={14}/></button>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;