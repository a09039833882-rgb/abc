/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
  Upload, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  Download,
  FileText,
  Calendar,
  Sparkles,
  Copy,
  Trash2,
  Plus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Initialize Gemini API
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

interface LicenseResult {
  id: string;
  originalImage: string;
  editedImage: string | null;
  data: {
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    street: string | null;
    city: string | null;
    state: string | null;
    zipcode: string | null;
    dateExp: string | null;
    dob: string | null;
    dlNumber: string | null;
    ssn: string | null; // Placeholder for manual entry
  } | null;
  targetYear: string;
  status: 'idle' | 'processing' | 'searching' | 'editing' | 'verifying' | 'completed' | 'error';
  consistencyScore?: number;
  stateRules?: string;
  error?: string;
}

export default function App() {
  const [results, setResults] = useState<LicenseResult[]>([]);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    const newResults: LicenseResult[] = [];
    let processedCount = 0;

    files.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const randomYear = (Math.floor(Math.random() * (2029 - 2027 + 1)) + 2027).toString();
        newResults.push({
          id: Math.random().toString(36).substr(2, 9),
          originalImage: reader.result as string,
          editedImage: null,
          data: null,
          targetYear: randomYear,
          status: 'idle'
        });
        processedCount++;
        if (processedCount === files.length) {
          setResults(prev => [...prev, ...newResults].slice(0, 50)); // Increased limit to 50
          if (e.target) e.target.value = ''; // Clear input to allow re-uploading same files
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const processItem = async (id: string, isRetry: boolean = false) => {
    // Helper for exponential backoff retry
    const callWithRetry = async (fn: () => Promise<any>, maxRetries = 5) => {
      let lastError: any;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: any) {
          lastError = err;
          const isRateLimit = err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED") || err.status === 429;
          
          if (isRateLimit && attempt < maxRetries - 1) {
            const waitTime = Math.pow(2, attempt) * 3000 + Math.random() * 1000;
            setResults(prev => prev.map(r => r.id === id ? { ...r, status: r.status, error: `API Busy. Retrying in ${Math.round(waitTime/1000)}s...` } : r));
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    };

    const currentItem = results.find(r => r.id === id);
    if (!currentItem) return;

    try {
      const originalBase64 = currentItem.originalImage.split(',')[1];

      // 1. Extract Data
      setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'processing', error: undefined } : r));

      const extractResponse = await callWithRetry(() => genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { inlineData: { data: originalBase64, mimeType: "image/jpeg" } },
              { text: `Extract the following information from this US driver's license in JSON format: 
                firstName, lastName, fullName, street, city, state, zipcode, dateExp, dob, dlNumber. 
                If any field is not found, leave it null. 
                Format: { "firstName": "...", "lastName": "...", "fullName": "...", "street": "...", "city": "...", "state": "...", "zipcode": "...", "dateExp": "...", "dob": "...", "dlNumber": "..." }` }
            ]
          }
        ],
        config: { responseMimeType: "application/json" }
      }));

      const extractedData = JSON.parse(extractResponse.text || '{}');
      const state = extractedData.state || "US";
      
      // 1.5 Search for State-Specific Rules
      setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'searching' } : r));
      
      let stateRules = "";
      try {
        const searchResponse = await callWithRetry(() => genAI.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `Find the exact visual location of the expiration date (EXP) on a ${state} driver's license. 
            Specifically: 
            1. Where is it located (e.g., top right, bottom left, next to the photo)? 
            2. What is the exact label used (e.g., "EXP", "4a", "Expires")?
            3. What color and font style is the date (e.g., red, bold, black)?
            4. Is it near any other specific fields like DOB or the DL number?`,
          config: {
            tools: [{ googleSearch: {} }]
          }
        }));
        stateRules = searchResponse.text || "";
      } catch (searchErr) {
        console.warn("Search grounding failed, proceeding with general rules", searchErr);
        stateRules = "General US driver's license rules apply.";
      }

      const dob = extractedData.dob || "the date of birth";
      const currentExp = extractedData.dateExp || "the expiration date";
      const issDate = extractedData.iss || "the issuance date";

      let originalYear = 0;
      if (currentExp && currentExp.includes('/')) {
        const parts = currentExp.split('/');
        const yearStr = parts[parts.length - 1];
        originalYear = parseInt(yearStr);
      } else if (currentExp && /\d{4}/.test(currentExp)) {
        const match = currentExp.match(/\d{4}/);
        if (match) originalYear = parseInt(match[0]);
      }

      let targetDate = currentExp;
      if (currentExp && currentExp.includes('/')) {
        const parts = currentExp.split('/');
        if (parts.length === 3) {
          targetDate = `${parts[0]}/${parts[1]}/${currentItem.targetYear}`;
        }
      }

      let attempts = 0;
      const maxAttempts = 5; // Increased attempts to reach the 70% threshold
      let finalEditedBase64 = "";
      let finalConsistencyScore = 0;

      while (attempts < maxAttempts) {
        attempts++;
        
        // 2. Edit Image
        setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'editing', error: attempts > 1 ? `Retrying (Attempt ${attempts}/${maxAttempts}). Score: ${finalConsistencyScore}%` : undefined } : r));

        const editResponse = await callWithRetry(() => genAI.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: {
            parts: [
              { inlineData: { data: originalBase64, mimeType: "image/jpeg" } },
              { text: `DOCUMENT MODIFICATION TASK - HIGH PRECISION
ATTEMPT: ${attempts}
STATE: ${state}

EXACT LOCATION AND STYLE RULES FOR ${state}:
${stateRules}

TARGET FIELD TO CHANGE:
- Label: The expiration label identified for ${state}
- Current Value: "${currentExp}"
- New Value: "${targetDate}" (Change year to ${currentItem.targetYear})

STRICTLY FORBIDDEN TO CHANGE:
- Label: "DOB" (Date of Birth)
- Value: "${dob}" (MUST REMAIN EXACTLY "${dob}")
- Any other text, background patterns, or security features.

INSTRUCTIONS:
1. Locate the expiration date based on the ${state} location rules provided above.
2. Replace the year in "${currentExp}" with "${currentItem.targetYear}".
3. ENSURE the text matches the original font, size, and color exactly as specified in the rules.
4. The final image must look like a real, unedited photograph.
5. DO NOT change the Date of Birth (DOB).` }
            ]
          }
        }));

        let editedBase64 = "";
        for (const part of editResponse.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            editedBase64 = `data:image/png;base64,${part.inlineData.data}`;
            break;
          }
        }

        if (!editedBase64) {
          if (attempts === maxAttempts) throw new Error("Image editing failed after multiple attempts.");
          continue;
        }

        // 3. Verify Consistency
        setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'verifying' } : r));

        const verifyResponse = await callWithRetry(() => genAI.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                { text: "Original Image:" },
                { inlineData: { data: originalBase64, mimeType: "image/jpeg" } },
                { text: "Modified Image:" },
                { inlineData: { data: editedBase64.split(',')[1], mimeType: "image/png" } },
                { text: `Compare these two images. Evaluate the consistency and synchronization.
Specifically check:
1. Is the Expiration Date (EXP) year changed to ${currentItem.targetYear}?
2. Is the Date of Birth (DOB) UNCHANGED and identical to the original?
3. Is the overall image quality, background, and security features identical to the original?

Return a JSON object with a 'score' (0-100) representing the consistency/synchronization percentage.
Format: { "score": number, "reason": "string" }` }
              ]
            }
          ],
          config: { responseMimeType: "application/json" }
        }));

        const verification = JSON.parse(verifyResponse.text || '{"score": 0}');
        finalConsistencyScore = verification.score;
        
        // Only keep the image if it meets the user's 70% threshold
        if (finalConsistencyScore >= 70) {
          finalEditedBase64 = editedBase64;
          break;
        } else {
          console.log(`Consistency score ${finalConsistencyScore}% too low (< 70%), retrying...`);
        }
      }

      const newData = { ...extractedData, ssn: currentItem.data?.ssn || "" };
      if (newData.dateExp && newData.dateExp.length >= 4) {
        newData.dateExp = newData.dateExp.replace(/\d{4}$/, currentItem.targetYear);
      }

      setResults(prev => prev.map(r => r.id === id ? { 
        ...r, 
        editedImage: finalEditedBase64 || null,
        data: newData,
        consistencyScore: finalConsistencyScore,
        stateRules: stateRules,
        status: finalConsistencyScore >= 70 ? 'completed' : 'error',
        error: finalConsistencyScore < 70 ? `Failed to reach 70% consistency (Final Score: ${finalConsistencyScore}%)` : undefined
      } : r));

    } catch (err: any) {
      console.error(err);
      const isRateLimit = err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED") || err.status === 429;
      const errorMsg = isRateLimit 
        ? "API Quota exhausted. Please wait 1-2 minutes before trying again." 
        : "Processing failed.";
      setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'error', error: errorMsg } : r));
    }
  };

  const processAll = async () => {
    if (results.length === 0 || isBatchProcessing) return;
    setIsBatchProcessing(true);

    // Get current IDs to process
    const idsToProcess = results
      .filter(r => r.status !== 'completed')
      .map(r => r.id);

    const CONCURRENCY_LIMIT = 5;
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < idsToProcess.length) {
        const id = idsToProcess[currentIndex++];
        if (id) {
          await processItem(id);
          // Small delay after finishing an item before picking up the next one
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    // Start workers
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, idsToProcess.length); i++) {
      workers.push(worker());
      // Stagger the start of each worker slightly
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await Promise.all(workers);
    setIsBatchProcessing(false);
  };

  const retryItem = async (id: string) => {
    await processItem(id, true);
  };

  const copyToClipboard = () => {
    const rows = results
      .filter(r => r.data)
      .map(r => {
        const d = r.data!;
        return `${d.firstName || ""}\t${d.lastName || ""}\t${d.fullName || ""}\t${d.street || ""}\t${d.city || ""}\t${d.state || ""}\t${d.zipcode || ""}\t${d.dateExp || ""}\t${d.dob || ""}\t${d.ssn || ""}\t${d.dlNumber || ""}`;
      });
    
    const text = rows.join("\n");
    navigator.clipboard.writeText(text);
    alert("Copied data to clipboard!");
  };

  const downloadAll = () => {
    const completedResults = results.filter(r => r.status === 'completed' && r.editedImage);
    completedResults.forEach((result, index) => {
      const link = document.createElement('a');
      link.href = result.editedImage!;
      link.download = `${index + 1}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  };

  const removeResult = (id: string) => {
    setResults(results.filter(r => r.id !== id));
  };

  const clearAll = () => {
    setResults([]);
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-[#1a1a1a] font-sans p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl font-light tracking-tight flex items-center gap-3">
              <FileText className="text-blue-600 w-10 h-10" />
              Batch <span className="font-bold">License Modifier</span>
            </h1>
            <p className="text-sm text-[#6c757d] mt-2">Focus: Expiration Date (2027-2029) | 90% Consistency Check</p>
          </div>
          <div className="flex gap-3">
            {results.length > 0 && (
              <>
                <button 
                  onClick={clearAll}
                  className="px-4 py-2 bg-white border border-red-200 text-red-600 rounded-xl text-sm font-medium hover:bg-red-50 transition-colors flex items-center gap-2"
                >
                  <Trash2 size={16} />
                  Clear All
                </button>
                <button 
                  onClick={downloadAll}
                  disabled={!results.some(r => r.status === 'completed' && r.editedImage)}
                  className="px-6 py-2 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Download size={16} />
                  Download All (1-5)
                </button>
                <button 
                  onClick={copyToClipboard}
                  disabled={!results.some(r => r.status === 'completed')}
                  className="px-6 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Copy size={16} />
                  Copy to Sheet
                </button>
              </>
            )}
          </div>
        </header>

        <main className="space-y-8">
          {/* Upload Section */}
          <section className="bg-white rounded-[2rem] p-8 shadow-sm border border-black/5">
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-blue-100 bg-blue-50/30 rounded-3xl p-12 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-50 hover:border-blue-300 transition-all group"
            >
              <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Plus className="text-blue-600 w-10 h-10" />
              </div>
              <h3 className="text-xl font-semibold text-blue-900">Upload 3-5 Licenses</h3>
              <p className="text-sm text-blue-600/70 mt-2">Select multiple images to start batch processing</p>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept="image/*" 
                multiple
                className="hidden" 
              />
            </div>

            {results.length > 0 && (
              <div className="mt-8">
                <button 
                  onClick={processAll}
                  disabled={isBatchProcessing}
                  className={`w-full py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all ${
                    isBatchProcessing 
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                      : 'bg-blue-600 text-white hover:bg-blue-700 shadow-xl hover:shadow-blue-200 active:scale-[0.99]'
                  }`}
                >
                  {isBatchProcessing ? (
                    <>
                      <RefreshCw size={24} className="animate-spin" />
                      Processing Batch...
                    </>
                  ) : (
                    <>
                      <Sparkles size={24} className="text-yellow-300" />
                      Start Batch Modification
                    </>
                  )}
                </button>
              </div>
            )}
          </section>

          {/* Results Grid */}
          <div className="grid grid-cols-1 gap-6">
            <AnimatePresence mode="popLayout">
              {results.map((result, index) => (
                <motion.div
                  key={result.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white rounded-3xl p-6 shadow-sm border border-black/5 flex flex-col lg:flex-row gap-6 relative group"
                >
                  <button 
                    onClick={() => removeResult(result.id)}
                    className="absolute top-4 right-4 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={18} />
                  </button>

                  {/* Images Section */}
                  <div className="lg:w-1/3 flex flex-col gap-4">
                    <div className="relative aspect-[1.6/1] rounded-2xl overflow-hidden bg-gray-100 border border-gray-100">
                      <img src={result.originalImage} alt="Original" className="w-full h-full object-cover" />
                      <div className="absolute top-2 left-2 px-2 py-1 bg-black/50 backdrop-blur-md text-white text-[10px] font-bold rounded-md uppercase">Original</div>
                    </div>
                    
                    {result.status === 'completed' && result.editedImage ? (
                      <div className="relative aspect-[1.6/1] rounded-2xl overflow-hidden bg-gray-100 border border-blue-100 shadow-inner">
                        <img src={result.editedImage} alt="Modified" className="w-full h-full object-cover" />
                        <div className="absolute top-2 left-2 px-2 py-1 bg-blue-600 text-white text-[10px] font-bold rounded-md uppercase">Modified {result.targetYear}</div>
                      </div>
                    ) : (
                      <div className="aspect-[1.6/1] rounded-2xl border-2 border-dashed border-gray-100 flex flex-col items-center justify-center text-gray-300">
                        {result.status === 'editing' ? (
                          <RefreshCw size={32} className="animate-spin text-blue-400" />
                        ) : (
                          <Sparkles size={32} />
                        )}
                        <p className="text-[10px] mt-2 font-bold uppercase tracking-widest">Modified Image</p>
                      </div>
                    )}
                  </div>

                  {/* Data Section */}
                  <div className="lg:flex-1">
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-3 h-3 rounded-full ${
                        result.status === 'completed' ? 'bg-green-500' : 
                        result.status === 'error' ? 'bg-red-500' : 
                        result.status === 'idle' ? 'bg-gray-300' : 
                        result.status === 'searching' ? 'bg-purple-500 animate-bounce' : 'bg-blue-500 animate-pulse'
                      }`} />
                      <h4 className="font-bold text-gray-900">License #{index + 1}</h4>
                      <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">Target: {result.targetYear}</span>
                      
                      {result.status === 'completed' && result.consistencyScore !== undefined && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          result.consistencyScore >= 90 ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                        }`}>
                          Sync: {result.consistencyScore}%
                        </span>
                      )}
                      
                      {(result.status === 'completed' || result.status === 'error') && (
                        <button 
                          onClick={() => retryItem(result.id)}
                          className="ml-auto p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex items-center gap-1 text-[10px] font-bold uppercase"
                          title="Retry processing"
                        >
                          <RefreshCw size={14} className={result.status === 'processing' || result.status === 'editing' ? 'animate-spin' : ''} />
                          Retry
                        </button>
                      )}
                    </div>

                    {result.data ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <DataField label="First Name" value={result.data.firstName} />
                        <DataField label="Last Name" value={result.data.lastName} />
                        <DataField label="Full Name" value={result.data.fullName} />
                        <DataField label="Street" value={result.data.street} />
                        <DataField label="City" value={result.data.city} />
                        <DataField label="State" value={result.data.state} />
                        <DataField label="Zipcode" value={result.data.zipcode} />
                        <DataField label="Date Exp" value={result.data.dateExp} />
                        <DataField label="DOB" value={result.data.dob} />
                        <DataField label="DL Number" value={result.data.dlNumber} />
                        <div className="p-2 bg-blue-50/50 rounded-xl border border-blue-100/50">
                          <p className="text-[9px] uppercase font-bold text-blue-400 mb-0.5">SSN</p>
                          <input 
                            type="text" 
                            placeholder="Manual entry"
                            className="text-xs font-bold w-full bg-transparent outline-none text-blue-900 placeholder:text-blue-200"
                            value={result.data.ssn || ""}
                            onChange={(e) => {
                              const newResults = [...results];
                              newResults[index].data!.ssn = e.target.value;
                              setResults(newResults);
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center py-8">
                        {result.status === 'processing' ? (
                          <div className="flex flex-col items-center gap-2">
                            <RefreshCw size={24} className="animate-spin text-blue-600" />
                            <p className="text-xs font-bold text-blue-600 uppercase tracking-widest">Scanning Data...</p>
                          </div>
                        ) : result.status === 'searching' ? (
                          <div className="flex flex-col items-center gap-2">
                            <Sparkles size={24} className="animate-pulse text-purple-600" />
                            <p className="text-xs font-bold text-purple-600 uppercase tracking-widest">Finding State Rules...</p>
                          </div>
                        ) : result.status === 'error' ? (
                          <div className="flex flex-col items-center gap-2 text-red-500">
                            <AlertCircle size={24} />
                            <p className="text-xs font-bold uppercase tracking-widest">{result.error || "Error"}</p>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400 italic">Waiting to start processing...</p>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </main>

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-gray-200 flex flex-col md:flex-row items-center justify-between gap-4 text-[#6c757d]">
          <p className="text-xs">© 2026 Batch License Modifier. For demonstration purposes only.</p>
          <div className="flex gap-8">
            <span className="text-[10px] uppercase tracking-widest font-black">Secure</span>
            <span className="text-[10px] uppercase tracking-widest font-black">AI-Powered</span>
            <span className="text-[10px] uppercase tracking-widest font-black">Spreadsheet Ready</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DataField({ label, value }: { label: string, value: string | null }) {
  return (
    <div className="p-2 bg-gray-50 rounded-xl border border-gray-100">
      <p className="text-[9px] uppercase font-bold text-gray-400 mb-0.5">{label}</p>
      <p className="text-xs font-bold text-gray-900 truncate">{value || "—"}</p>
    </div>
  );
}
