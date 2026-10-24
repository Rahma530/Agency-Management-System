import React, { useState } from 'react';
import { parseReportContentIntoParagraphs } from '../../lib/pdfExport';
import { parseWorkLogEntries } from '../../lib/reportHtmlExport';

// Live preview for the draft editor's plain-text content_text — shown directly under the textarea
// in ReportDraftWorkspace.tsx so an attachment link reads the same way while editing as it will in
// the final PDF/HTML export: a real image thumbnail when the URL is one, a short "View attachment"
// link otherwise. Never a raw, 150+ character signed URL sitting on its own line.
//
// Deliberately NOT a re-fetch-and-base64-encode pass like loadEmbeddableImages/resolveEmbeddableImages
// (pdfExport.ts/embeddableImages.ts) — that exists so an exported file keeps working after the
// signed URL's 30-day TTL expires, which doesn't matter here: this preview is only ever shown
// live, while the signed URL is still fresh, so the browser can just load it directly as an <img
// src>. Whether a given URL is actually an image is decided by whether the <img> succeeds to load
// (onError), never guessed from the URL's path/extension — a signed Storage URL's path is not a
// reliable content-type signal (same reasoning embeddableImages.ts documents for its own sniff).
function AttachmentPreview({ url }: { url: string }): React.ReactElement {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center px-2 py-1 rounded-md text-[11px] font-semibold text-purple-300 bg-purple-900/30 border border-purple-700/40 hover:text-white hover:bg-purple-800/50"
      >
        View attachment
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open attachment">
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="w-20 h-20 object-cover rounded-lg border border-purple-900/40 bg-black/40"
      />
    </a>
  );
}

export interface ReportContentPreviewProps {
  contentText: string;
}

// Reuses parseReportContentIntoParagraphs (pdfExport.ts) and parseWorkLogEntries
// (reportHtmlExport.ts) verbatim — the exact same section/entry split the PDF and HTML exporters
// already use — so this preview can never drift from what actually ends up in the exported file.
export const ReportContentPreview: React.FC<ReportContentPreviewProps> = ({ contentText }) => {
  if (!contentText.trim()) return null;

  const sections = parseReportContentIntoParagraphs(contentText);

  return (
    <div className="space-y-3">
      {sections.map((section, sectionIndex) => {
        const entries = parseWorkLogEntries(section.body);
        if (!entries.length) return null;
        return (
          <div key={sectionIndex}>
            {sections.length > 1 && (
              <p className="text-[11px] font-bold text-purple-300 mb-1.5">{section.heading}</p>
            )}
            <div className="space-y-1.5">
              {entries.map((entry, entryIndex) => (
                <div
                  key={entryIndex}
                  className="p-2.5 rounded-lg border border-purple-900/30 bg-[#100c1c]"
                >
                  {entry.text && (
                    <p dir="auto" className="text-xs text-stone-200 whitespace-pre-wrap break-words">
                      {entry.text}
                    </p>
                  )}
                  {entry.attachmentUrls.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {entry.attachmentUrls.map((url, urlIndex) => (
                        <AttachmentPreview key={urlIndex} url={url} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
