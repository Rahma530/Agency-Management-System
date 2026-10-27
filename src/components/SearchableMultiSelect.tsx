import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';

export interface SearchableMultiSelectOption {
  id: string;
  label: string;
  sublabel?: string;
  badge?: React.ReactNode;
}

interface SearchableMultiSelectProps {
  options: SearchableMultiSelectOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  /** Max chips shown in the closed trigger before collapsing to "first +N". Default 2. */
  maxVisibleChips?: number;
  /**
   * Ids that must stay selected and can't be unchecked or removed here — e.g. a task's creator,
   * who the set_task_assignees RPC always rejects removing (raises "The task's creator cannot be
   * removed from its assignee list."). Locking it in the picker itself means that server-side
   * rule is never hit through this control: the checkbox/chip for a locked id is still shown
   * (and can carry a sublabel like "(creator)") but can't be toggled off.
   */
  lockedIds?: string[];
}

// Closed-by-default searchable multi-select: the trigger looks like a normal <select> (same
// bg-stone-900/border-stone-800 language as every other form control in this app) and shows
// selected items as removable chips — never an always-open checkbox list. Rendered via a portal
// so its open dropdown can never be clipped by a modal's own `overflow-y-auto` container, and
// positioned from the trigger's live bounding rect so it tracks correctly inside a scrolled
// modal. Selection order is preserved (new picks append to the end) — callers that need "first
// selected = primary" (e.g. the Assignees picker, where first = tasks.assigned_to) get that for
// free without any extra bookkeeping here.
export const SearchableMultiSelect: React.FC<SearchableMultiSelectProps> = ({
  options,
  selectedIds,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No options available.',
  disabled = false,
  maxVisibleChips = 2,
  lockedIds = [],
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number; openUpward: boolean } | null>(null);

  const selectedOptions = useMemo(
    () => selectedIds.map((id) => options.find((o) => o.id === id)).filter((o): o is SearchableMultiSelectOption => !!o),
    [selectedIds, options]
  );

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(normalized) || o.sublabel?.toLowerCase().includes(normalized)
    );
  }, [options, query]);

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUpward = spaceBelow < 180 && spaceAbove > spaceBelow;
    setPosition({
      left: rect.left,
      width: rect.width,
      // When opening upward, `top` anchors the trigger's top edge; `translateY(-100%)` below
      // (applied via openUpward) then shifts the dropdown fully above it by its own rendered
      // height, which isn't known until after it paints — translateY sidesteps needing it.
      top: openUpward ? rect.top - margin : rect.bottom + margin,
      maxHeight: Math.max(140, Math.min(320, openUpward ? spaceAbove : spaceBelow)),
      openUpward,
    });
  };

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    searchInputRef.current?.focus();
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  const toggleOption = (id: string) => {
    if (selectedIds.includes(id)) {
      if (lockedIds.includes(id)) return;
      onChange(selectedIds.filter((existing) => existing !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const removeChip = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (lockedIds.includes(id)) return;
    onChange(selectedIds.filter((existing) => existing !== id));
  };

  const visibleChips = selectedOptions.slice(0, maxVisibleChips);
  const overflowCount = selectedOptions.length - visibleChips.length;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full min-h-[38px] items-center justify-between gap-2 rounded-xl border border-stone-800 bg-stone-900 px-3 py-2 text-left text-xs text-white focus:outline-none focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {selectedOptions.length === 0 ? (
          <span className="text-stone-500">{placeholder}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {visibleChips.map((option) => (
              <span
                key={option.id}
                className="flex items-center gap-1 rounded-full bg-purple-900/40 px-2 py-0.5 text-[11px] font-semibold text-purple-200"
              >
                <span className="max-w-[140px] truncate">{option.label}</span>
                {!disabled && !lockedIds.includes(option.id) && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => removeChip(option.id, e)}
                    className="rounded-full p-0.5 hover:bg-white/10"
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="rounded-full bg-stone-800 px-2 py-0.5 text-[11px] font-semibold text-stone-300">
                +{overflowCount}
              </span>
            )}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && position && createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          style={{
            position: 'fixed',
            left: position.left,
            width: position.width,
            top: position.top,
            transform: position.openUpward ? 'translateY(-100%)' : undefined,
            zIndex: 1000,
          }}
          className="rounded-xl border border-stone-800 bg-stone-900 shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-stone-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-stone-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-xs text-white placeholder:text-stone-500 focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto p-1.5" style={{ maxHeight: position.maxHeight }}>
            {filteredOptions.length === 0 && (
              <p className="px-2 py-2 text-xs text-stone-500">{options.length === 0 ? emptyMessage : 'No matches.'}</p>
            )}
            {filteredOptions.map((option) => {
              const checked = selectedIds.includes(option.id);
              const locked = checked && lockedIds.includes(option.id);
              return (
                <label
                  key={option.id}
                  role="option"
                  aria-selected={checked}
                  title={locked ? "Required — can't be removed here." : undefined}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-stone-200 ${locked ? 'cursor-not-allowed opacity-80' : 'cursor-pointer hover:bg-white/5'}`}
                >
                  <input type="checkbox" checked={checked} disabled={locked} onChange={() => toggleOption(option.id)} />
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                    {option.sublabel && <span className="text-stone-500"> ({option.sublabel})</span>}
                  </span>
                  {option.badge && <span className="shrink-0 text-[10px] text-stone-400">{option.badge}</span>}
                </label>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
