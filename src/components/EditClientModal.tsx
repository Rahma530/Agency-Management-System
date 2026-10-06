import React, { useState } from 'react';
import { X, Building2, UserCheck, Globe, Briefcase, Phone, Layers, Plus, StickyNote, ChevronDown, Save, DollarSign, Calendar } from 'lucide-react';
import { ClientRecord, ClientSector, ServiceType } from '../types/database';
import {
  CLIENT_SERVICE_OPTIONS,
  COMPREHENSIVE_SERVICES,
  ClientServiceOption,
  clientServicesChanged,
  getClientCustomServices,
  getClientServices,
  splitClientServices,
} from '../lib/clientServices';

interface EditClientModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ClientRecord;
  onSave: (clientId: string, patch: Record<string, unknown>) => Promise<void>;
}

const SECTOR_OPTIONS: ClientSector[] = ['E-Commerce', 'Service'];
const INDUSTRY_OPTIONS = ['عطور/بخور', 'عبايات', 'أحذية وشنط', 'أخرى'];

export const EditClientModal: React.FC<EditClientModalProps> = ({ isOpen, onClose, client, onSave }) => {
  const [name, setName] = useState(client.name);
  const [contactName, setContactName] = useState(client.client_contact_name || '');
  const [phoneNumber, setPhoneNumber] = useState(client.phone_number || '');
  const [websiteOrSocialLink, setWebsiteOrSocialLink] = useState(client.website_or_social_link || '');
  const [sector, setSector] = useState<ClientSector | ''>(client.sector || '');
  const [industry, setIndustry] = useState(client.industry || '');
  const [isIndustryOpen, setIsIndustryOpen] = useState(false);
  const [activeIndustryIndex, setActiveIndustryIndex] = useState(-1);
  // Reconstructs the registration form's raw checkbox-selection shape from the client's current
  // services: getClientServices() already returns the normalized union of services +
  // other_services, restricted to canonical ServiceType values — exactly the core-plus-interface/
  // creation/branding selection the checkboxes above represent. Free-text other_services entries
  // (not a checkbox selection) come from getClientCustomServices() instead. splitClientServices is
  // idempotent, so re-running it on this reconstructed selection at save time reproduces the exact
  // same split whenever nothing was actually changed.
  const [selectedServices, setSelectedServices] = useState<ServiceType[]>(getClientServices(client));
  const [customServices, setCustomServices] = useState<string[]>(getClientCustomServices(client));
  const [customServiceInput, setCustomServiceInput] = useState('');
  const [salesBrief, setSalesBrief] = useState(client.sales_brief || '');
  const [contractValue, setContractValue] = useState<number | ''>(client.contract_value ?? '');
  const [dueValue, setDueValue] = useState<number | ''>(client.due_value ?? '');
  const [remainingValue, setRemainingValue] = useState<number | ''>(client.remaining_value ?? '');
  const [contractDurationMonths, setContractDurationMonths] = useState<number | ''>(client.contract_duration_months ?? '');
  const [startDate, setStartDate] = useState(client.start_date || '');
  const [renewalDate, setRenewalDate] = useState(client.renewal_date || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  if (!isOpen) return null;

  const toggleService = (service: ClientServiceOption) => {
    if (service === 'comprehensive') {
      setSelectedServices((prev) => {
        const allCoreSelected = COMPREHENSIVE_SERVICES.every((s) => prev.includes(s));
        return allCoreSelected
          ? prev.filter((s) => !COMPREHENSIVE_SERVICES.includes(s))
          : Array.from(new Set([...prev, ...COMPREHENSIVE_SERVICES]));
      });
      return;
    }
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    );
  };

  const addCustomService = () => {
    const trimmed = customServiceInput.trim();
    if (!trimmed) return;
    setCustomServices((prev) =>
      prev.some((s) => s.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed]
    );
    setCustomServiceInput('');
  };

  const removeCustomService = (value: string) => {
    setCustomServices((prev) => prev.filter((s) => s !== value));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveError('Please enter the client / company name.');
      return;
    }
    if (!industry.trim()) {
      setSaveError('Please enter an industry.');
      return;
    }
    if (selectedServices.length === 0 && customServices.length === 0) {
      setSaveError('Please select at least one service.');
      return;
    }
    const numericFields: [number | '', string][] = [
      [contractValue, 'Monthly Retainer'],
      [dueValue, 'Due Value'],
      [remainingValue, 'Remaining Value'],
      [contractDurationMonths, 'Contract Duration'],
    ];
    for (const [value, label] of numericFields) {
      if (value !== '' && Number(value) < 0) {
        setSaveError(`${label} must be >= 0.`);
        return;
      }
    }

    const { services, other_services } = splitClientServices([...selectedServices, ...customServices]);

    // Diff against the client as currently loaded — only a field that actually changed goes in
    // the patch, since update_client_details treats "key present" as "write this column" and
    // there's no reason to re-write a column to the value it already holds.
    const patch: Record<string, unknown> = {};
    if (name.trim() !== client.name) patch.name = name.trim();
    if ((contactName.trim() || null) !== (client.client_contact_name || null)) {
      patch.client_contact_name = contactName.trim() || null;
    }
    if ((phoneNumber.trim() || null) !== (client.phone_number || null)) {
      patch.phone_number = phoneNumber.trim() || null;
    }
    if ((websiteOrSocialLink.trim() || null) !== (client.website_or_social_link || null)) {
      patch.website_or_social_link = websiteOrSocialLink.trim() || null;
    }
    if ((sector || null) !== (client.sector || null)) patch.sector = sector || null;
    if ((industry.trim() || null) !== (client.industry || null)) patch.industry = industry.trim() || null;
    const { servicesChanged, otherServicesChanged } = clientServicesChanged(client, { services, other_services });
    if (servicesChanged) patch.services = services;
    if (otherServicesChanged) patch.other_services = other_services;
    if ((salesBrief.trim() || null) !== (client.sales_brief || null)) patch.sales_brief = salesBrief.trim() || null;
    if ((contractValue === '' ? null : Number(contractValue)) !== (client.contract_value ?? null)) {
      patch.contract_value = contractValue === '' ? null : Number(contractValue);
    }
    if ((dueValue === '' ? null : Number(dueValue)) !== (client.due_value ?? null)) {
      patch.due_value = dueValue === '' ? null : Number(dueValue);
    }
    if ((remainingValue === '' ? null : Number(remainingValue)) !== (client.remaining_value ?? null)) {
      patch.remaining_value = remainingValue === '' ? null : Number(remainingValue);
    }
    if ((contractDurationMonths === '' ? null : Number(contractDurationMonths)) !== (client.contract_duration_months ?? null)) {
      patch.contract_duration_months = contractDurationMonths === '' ? null : Number(contractDurationMonths);
    }
    if ((startDate || null) !== (client.start_date || null)) patch.start_date = startDate || null;
    if ((renewalDate || null) !== (client.renewal_date || null)) patch.renewal_date = renewalDate || null;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSaveError('');
    setIsSaving(true);
    try {
      await onSave(client.id, patch);
      onClose();
    } catch (err: any) {
      setSaveError(err?.message || 'Unable to save these changes.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" dir="ltr">
      <div
        className="w-full max-w-xl max-h-[90vh] rounded-[20px] p-6 shadow-2xl relative overflow-x-hidden overflow-y-auto font-sans"
        style={{ background: 'var(--gradient-card)', border: '1px solid var(--border-medium)' }}
      >
        <div className="flex items-center justify-between pb-4 mb-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-[12px] flex items-center justify-center text-white"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold" style={{ color: 'var(--white)' }}>Edit Client</h3>
              <p className="text-xs" style={{ color: 'var(--grey)' }}>{client.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-white transition-colors"
            style={{ background: 'rgba(255, 255, 255, 0.05)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p
          className="p-3 mb-4 rounded-lg text-[11px]"
          style={{ background: 'rgba(123, 47, 247, 0.1)', border: '1px solid var(--border-soft)', color: 'var(--grey)' }}
        >
          AM/Sales assignment, status, and the signed contract aren't edited here — use AM Queue for
          assignments, and the Client Lifecycle card for status changes.
        </p>

        {saveError && (
          <div
            className="p-3 mb-4 rounded-lg text-xs"
            style={{ background: 'rgba(245, 163, 163, 0.15)', border: '1px solid var(--roas-bad)', color: 'var(--roas-bad)' }}
          >
            {saveError}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Company / Client Name <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Contact Person (optional)
              </label>
              <div className="relative">
                <UserCheck className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Website / Social Link (optional)
              </label>
              <div className="relative">
                <Globe className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  value={websiteOrSocialLink}
                  onChange={(e) => setWebsiteOrSocialLink(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Sector</label>
              <div className="relative">
                <Briefcase className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <select
                  value={sector}
                  onChange={(e) => setSector(e.target.value as ClientSector | '')}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400 cursor-pointer"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                >
                  <option value="">Not set</option>
                  {SECTOR_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Industry <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Briefcase className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => {
                    setIndustry(e.target.value);
                    setIsIndustryOpen(true);
                    setActiveIndustryIndex(-1);
                  }}
                  onFocus={() => setIsIndustryOpen(true)}
                  onBlur={() => setIsIndustryOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setIsIndustryOpen(true);
                      setActiveIndustryIndex((current) => Math.min(current + 1, INDUSTRY_OPTIONS.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setActiveIndustryIndex((current) => Math.max(current - 1, 0));
                    } else if (e.key === 'Enter' && isIndustryOpen && activeIndustryIndex >= 0) {
                      e.preventDefault();
                      setIndustry(INDUSTRY_OPTIONS[activeIndustryIndex]);
                      setIsIndustryOpen(false);
                      setActiveIndustryIndex(-1);
                    } else if (e.key === 'Escape') {
                      setIsIndustryOpen(false);
                      setActiveIndustryIndex(-1);
                    }
                  }}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isIndustryOpen}
                  aria-controls="edit-client-industry-options"
                  aria-activedescendant={activeIndustryIndex >= 0 ? `edit-client-industry-option-${activeIndustryIndex}` : undefined}
                  autoComplete="off"
                  className="w-full pl-9 pr-9 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
                <ChevronDown className="w-4 h-4 absolute right-3 top-3 text-stone-400 pointer-events-none" />
                {isIndustryOpen && (
                  <div
                    id="edit-client-industry-options"
                    role="listbox"
                    className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl py-1 shadow-xl"
                    style={{ background: 'rgb(18, 16, 24)', border: '1px solid var(--border-soft)' }}
                  >
                    {INDUSTRY_OPTIONS.map((option, index) => (
                      <button
                        key={option}
                        id={`edit-client-industry-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={industry === option}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setIndustry(option);
                          setIsIndustryOpen(false);
                          setActiveIndustryIndex(-1);
                        }}
                        onMouseEnter={() => setActiveIndustryIndex(index)}
                        className="w-full px-3 py-2.5 text-left text-sm transition-colors hover:bg-purple-500/20"
                        style={{
                          background: activeIndustryIndex === index ? 'rgba(168, 85, 247, 0.18)' : 'transparent',
                          color: 'var(--white)',
                        }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Phone Number</label>
            <div className="relative">
              <Phone className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Monthly Retainer (optional)</label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  min={0}
                  value={contractValue}
                  onChange={(e) => setContractValue(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Start Date</label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Due Value (optional)</label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  min={0}
                  value={dueValue}
                  onChange={(e) => setDueValue(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Remaining Value (optional)</label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  min={0}
                  value={remainingValue}
                  onChange={(e) => setRemainingValue(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Contract Duration (months, optional)</label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  min={0}
                  value={contractDurationMonths}
                  onChange={(e) => setContractDurationMonths(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Renewal Date</label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="date"
                  value={renewalDate}
                  onChange={(e) => setRenewalDate(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Services <span className="text-red-400">*</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {CLIENT_SERVICE_OPTIONS.filter((opt) => opt.group === 'main').map((opt) => {
                const isSelected = opt.value === 'comprehensive'
                  ? COMPREHENSIVE_SERVICES.every((s) => selectedServices.includes(s))
                  : selectedServices.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleService(opt.value)}
                    className="px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 justify-center"
                    style={
                      isSelected
                        ? { background: 'rgba(123, 47, 247, 0.3)', color: 'var(--purple-light)', border: '1px solid var(--purple)' }
                        : { background: 'rgba(10, 10, 13, 0.8)', color: 'var(--grey)', border: '1px solid var(--border-soft)' }
                    }
                  >
                    <Layers className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Other Services</label>
            <p className="text-[11px] text-stone-400 mb-1.5">
              Optional add-ons — independent of شاملة and every other service above. Anything not
              listed can be added as free text below.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              {CLIENT_SERVICE_OPTIONS.filter((opt) => opt.group === 'other').map((opt) => {
                const isSelected = selectedServices.includes(opt.value as ServiceType);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleService(opt.value)}
                    className="px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 justify-center"
                    style={
                      isSelected
                        ? { background: 'rgba(123, 47, 247, 0.3)', color: 'var(--purple-light)', border: '1px solid var(--purple)' }
                        : { background: 'rgba(10, 10, 13, 0.8)', color: 'var(--grey)', border: '1px solid var(--border-soft)' }
                    }
                  >
                    <Layers className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={customServiceInput}
                onChange={(e) => setCustomServiceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomService();
                  }
                }}
                placeholder="Add another service..."
                className="flex-1 px-3 py-2 rounded-xl text-xs transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{ background: 'rgba(10, 10, 13, 0.8)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
              />
              <button
                type="button"
                onClick={addCustomService}
                className="px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1"
                style={{ background: 'rgba(123, 47, 247, 0.3)', color: 'var(--purple-light)', border: '1px solid var(--purple)' }}
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
            {customServices.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {customServices.map((service) => (
                  <span
                    key={service}
                    className="px-2 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1.5"
                    style={{ background: 'rgba(10, 10, 13, 0.8)', color: 'var(--grey)', border: '1px solid var(--border-soft)' }}
                  >
                    {service}
                    <button type="button" onClick={() => removeCustomService(service)} className="text-stone-400 hover:text-white">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Sales Brief (optional)</label>
            <div className="relative">
              <StickyNote className="w-4 h-4 absolute left-3 top-3 text-purple-400 pointer-events-none" />
              <textarea
                value={salesBrief}
                onChange={(e) => setSalesBrief(e.target.value)}
                rows={2}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{ background: 'rgba(10, 10, 13, 0.9)', border: '1px solid var(--border-soft)', color: 'var(--white)' }}
              />
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium transition-colors"
              style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--grey)', border: '1px solid var(--border-soft)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-2"
              style={{
                background: 'var(--gradient-badge)',
                color: 'var(--white)',
                border: '1px solid var(--border-strong)',
                opacity: isSaving ? 0.7 : 1,
              }}
            >
              <Save className="w-3.5 h-3.5" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
