import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { ClientRecord } from '../types/database';
import { matchesClientQuery } from '../lib/clientSearch';

interface DailyLogClientPickerProps {
  clients: ClientRecord[];
  selectedClientIds: string[];
  onChange: (ids: string[]) => void;
}

// Scrollable, searchable multi-select for the daily log create form's Client field — one
// daily_logs row gets written per selected client (see DailyOperationsModule.tsx/MyWorkHub.tsx's
// submit handlers), never an array column. No selection at all keeps the existing "not specific
// to one client" behavior.
export const DailyLogClientPicker: React.FC<DailyLogClientPickerProps> = ({
  clients,
  selectedClientIds,
  onChange,
}) => {
  const [query, setQuery] = useState('');
  const filteredClients = useMemo(
    () => clients.filter((c) => matchesClientQuery(c, query)),
    [clients, query]
  );

  const toggleClient = (id: string) => {
    onChange(
      selectedClientIds.includes(id)
        ? selectedClientIds.filter((existing) => existing !== id)
        : [...selectedClientIds, id]
    );
  };

  const selectAllVisible = () => {
    const visibleIds = filteredClients.map((c) => c.id);
    onChange(Array.from(new Set([...selectedClientIds, ...visibleIds])));
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <div className="relative flex-1">
          <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients..."
            className="w-full pl-7 pr-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 outline-none focus:border-purple-400"
          />
        </div>
        <button
          type="button"
          onClick={selectAllVisible}
          disabled={filteredClients.length === 0}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-purple-300 bg-purple-900/30 hover:bg-purple-800/50 border border-purple-700/40 disabled:opacity-40 whitespace-nowrap"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={selectedClientIds.length === 0}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-stone-400 hover:text-white bg-stone-900 border border-stone-800 disabled:opacity-40 whitespace-nowrap"
        >
          Clear
        </button>
      </div>

      <div className="max-h-36 overflow-y-auto p-2 rounded-xl bg-stone-900/90 border border-stone-800 space-y-1">
        {filteredClients.length === 0 ? (
          <p className="text-xs text-stone-500 px-1 py-1">No clients match.</p>
        ) : (
          filteredClients.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-2 p-1.5 rounded hover:bg-stone-800 cursor-pointer text-xs text-stone-300"
            >
              <input
                type="checkbox"
                checked={selectedClientIds.includes(c.id)}
                onChange={() => toggleClient(c.id)}
                className="rounded border-stone-700 text-purple-600 focus:ring-0"
              />
              <span className="font-semibold text-white">{c.name}</span>
            </label>
          ))
        )}
      </div>

      <p className="text-[10px] text-stone-500 mt-1">
        {selectedClientIds.length === 0
          ? 'No client selected — this log will be saved as not specific to one client.'
          : `${selectedClientIds.length} client${selectedClientIds.length === 1 ? '' : 's'} selected — one log entry will be saved for each.`}
      </p>
    </div>
  );
};
