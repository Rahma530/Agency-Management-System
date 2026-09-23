import React, { useRef, useState } from 'react';
import { X, UserCheck, Sparkles, Building2, Briefcase, DollarSign, Calendar, Users, Phone, Layers, Globe, ChevronDown, FileSignature, StickyNote } from 'lucide-react';
import { ClientSector, ServiceType, UserRecord } from '../types/database';
import { COMPREHENSIVE_SERVICES, CLIENT_SERVICE_OPTIONS, ClientServiceOption } from '../lib/clientServices';
import { CONTRACT_ALLOWED_MIME_TYPES, CONTRACT_MAX_FILE_SIZE_BYTES, formatContractFileSize } from '../lib/clientContracts';

interface ClientRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserRecord;
  amTeamLeaders?: UserRecord[];
  amAgents?: UserRecord[];
  onSubmit: (
    clientData: {
      name: string;
      client_contact_name?: string;
      sector: ClientSector;
      industry: string;
      services: ServiceType[];
      phone_number?: string;
      website_or_social_link?: string;
      contract_value: number;
      due_value?: number;
      remaining_value?: number;
      start_date: string;
      contract_duration_months?: number;
      renewal_date: string;
      am_team_lead_id?: string;
      am_agent_id?: string;
      notes?: string;
    },
    contractFile: File
  ) => Promise<void>;
}

const addOneYear = (dateStr: string): string => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
};

const addMonths = (dateStr: string, months: number): string => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
};

const SECTOR_OPTIONS: ClientSector[] = ['E-Commerce', 'Service'];
const INDUSTRY_OPTIONS = ['عطور/بخور', 'عبايات', 'أحذية وشنط', 'أخرى'];

export const ClientRegistrationModal: React.FC<ClientRegistrationModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  amTeamLeaders = [],
  amAgents = [],
  onSubmit,
}) => {
  // Management assignments start empty; Sales and AM Agent retain their lead picker default.
  const isAmForm = currentUser.role === 'am_team_lead' || currentUser.role === 'am_agent';
  const isLeadershipForm = currentUser.role === 'executive' || currentUser.role === 'head_of_technical';
  const isManagementForm = isLeadershipForm || currentUser.role === 'am_team_lead';

  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [sector, setSector] = useState<ClientSector | ''>('');
  const [industry, setIndustry] = useState('');
  const [isIndustryOpen, setIsIndustryOpen] = useState(false);
  const [activeIndustryIndex, setActiveIndustryIndex] = useState(-1);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [websiteOrSocialLink, setWebsiteOrSocialLink] = useState('');
  const [selectedServices, setSelectedServices] = useState<ServiceType[]>([]);
  const [contractValue, setContractValue] = useState<number | ''>('');
  const [dueValue, setDueValue] = useState<number | ''>('');
  const [remainingValue, setRemainingValue] = useState<number | ''>('');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [contractDurationMonths, setContractDurationMonths] = useState<number | ''>('');
  const [renewalDate, setRenewalDate] = useState(addOneYear(new Date().toISOString().split('T')[0]));
  const [renewalDateTouched, setRenewalDateTouched] = useState(false);
  const [amTeamLeadId, setAmTeamLeadId] = useState('');
  const [amAgentId, setAmAgentId] = useState('');
  const [notes, setNotes] = useState('');
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractFileError, setContractFileError] = useState('');
  const contractFileInputRef = useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (isManagementForm) {
      setAmTeamLeadId('');
      setAmAgentId('');
    }
  }, [isOpen, currentUser.id, isManagementForm]);
  // Sales/AM Agent never pick an AM Team Lead manually (the field is hidden for them below) —
  // instead this auto-resolves to the one real, currently-active am_team_lead if there's exactly
  // one. Zero or more than one active lead falls back to genuinely unassigned (null) rather than
  // guessing, so this keeps working correctly once a second AM Team Lead exists — at that point
  // AMQueue's unfiltered "Client Onboarding & Reception" queue is the existing safety net that
  // lets any am_team_lead claim it. Never a hardcoded placeholder id.
  const soleActiveAmTeamLeadId = amTeamLeaders.length === 1 ? amTeamLeaders[0].id : undefined;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Please enter the client / company name.');
      return;
    }
    if (!sector) {
      setErrorMsg('Please select a sector.');
      return;
    }
    if (!industry.trim()) {
      setErrorMsg('Please select or enter an industry.');
      return;
    }
    if (selectedServices.length === 0) {
      setErrorMsg('Please select at least one service.');
      return;
    }
    if (!contractFile) {
      setErrorMsg('Please upload the signed contract file.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg('');
    try {
      await onSubmit(
        {
          name: name.trim(),
          client_contact_name: contactName.trim() || undefined,
          sector,
          industry: industry.trim(),
          services: selectedServices,
          phone_number: phoneNumber.trim() || undefined,
          website_or_social_link: websiteOrSocialLink.trim() || undefined,
          contract_value: contractValue ? Number(contractValue) : 0,
          due_value: dueValue === '' ? undefined : Number(dueValue),
          remaining_value: remainingValue === '' ? undefined : Number(remainingValue),
          start_date: startDate,
          contract_duration_months: contractDurationMonths === '' ? undefined : Number(contractDurationMonths),
          renewal_date: renewalDate,
          am_team_lead_id: isManagementForm ? (amTeamLeadId || undefined) : soleActiveAmTeamLeadId,
          ...(isManagementForm ? { am_agent_id: amAgentId || undefined } : {}),
          notes: notes.trim() || undefined,
        },
        contractFile
      );
      // reset
      setName('');
      setContactName('');
      setSector('');
      setIndustry('');
      setIsIndustryOpen(false);
      setActiveIndustryIndex(-1);
      setPhoneNumber('');
      setWebsiteOrSocialLink('');
      setSelectedServices([]);
      setContractValue('');
      setDueValue('');
      setRemainingValue('');
      setContractDurationMonths('');
      if (isManagementForm) {
        setAmTeamLeadId('');
        setAmAgentId('');
      }
      setNotes('');
      setContractFile(null);
      setContractFileError('');
      setRenewalDateTouched(false);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error registering client');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleService = (service: ClientServiceOption) => {
    if (service === 'comprehensive') {
      // Orthogonal to Creation/Branding (the "Additional Services" section below) — only ever
      // adds/removes the 4 COMPREHENSIVE_SERVICES, never touching whatever additional-service
      // selections already exist, so a client can be شاملة + Branding at the same time.
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

  // Client-side validation only, mirroring ClientContractsPanel.tsx's own check exactly (same
  // shared constants) — Storage enforces both server-side regardless. The actual upload happens
  // after the client row is created (App.tsx's handleRegisterClient calls the same
  // handleUploadClientContract this whole app already uses post-registration), since the storage
  // path needs a real client id.
  const handleContractFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setContractFileError('');

    if (!CONTRACT_ALLOWED_MIME_TYPES.includes(file.type)) {
      setContractFileError(`File type not allowed (${file.type || 'unknown'}). Allowed: PDF, Word documents, or scanned images.`);
      return;
    }
    if (file.size > CONTRACT_MAX_FILE_SIZE_BYTES) {
      setContractFileError(`File too large (${formatContractFileSize(file.size)}) — the limit is 20MB.`);
      return;
    }
    setContractFile(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" dir="ltr">
      <div
        className="w-full max-w-xl max-h-[90vh] rounded-[20px] p-6 shadow-2xl relative overflow-x-hidden overflow-y-auto font-sans"
        style={{
          background: 'var(--gradient-card)',
          border: '1px solid var(--border-medium)',
        }}
      >
        {/* Top glow */}
        <div
          className="absolute -top-20 -right-20 w-48 h-48 rounded-full pointer-events-none opacity-40 blur-2xl"
          style={{ background: 'radial-gradient(circle, var(--purple) 0%, transparent 70%)' }}
        />

        <div className="flex items-center justify-between pb-4 mb-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-[12px] flex items-center justify-center text-white"
              style={{ background: 'var(--gradient-badge)', border: '1px solid var(--border-strong)' }}
            >
              <UserCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold" style={{ color: 'var(--white)' }}>
                Register New Client
              </h3>
              <p className="text-xs" style={{ color: 'var(--grey)' }}>
                {isManagementForm
                  ? 'Client will be registered for onboarding. AM assignments can be made now or later.'
                  : isAmForm
                    ? 'Client will be created as an already-active account under your management.'
                    : 'Client will be created and routed to Account Management to begin onboarding'}
              </p>
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

        {errorMsg && (
          <div
            className="p-3 mb-4 rounded-lg text-xs"
            style={{ background: 'rgba(245, 163, 163, 0.15)', border: '1px solid var(--roas-bad)', color: 'var(--roas-bad)' }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Company / Client Name <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Apex Global Trading"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{
                  background: 'rgba(10, 10, 13, 0.8)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--white)',
                }}
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
                  placeholder="e.g. Khaled"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
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
                  placeholder="Website URL, or a social media handle/link"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Sector <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Briefcase className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <select
                  required
                  value={sector}
                  onChange={(e) => setSector(e.target.value as ClientSector | '')}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400 cursor-pointer"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                >
                  <option value="">Select sector</option>
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
                  required
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
                  placeholder="Select or type an industry"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isIndustryOpen}
                  aria-controls="client-industry-options"
                  aria-activedescendant={activeIndustryIndex >= 0 ? `client-industry-option-${activeIndustryIndex}` : undefined}
                  autoComplete="off"
                  className="w-full pl-9 pr-9 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
                <ChevronDown className="w-4 h-4 absolute right-3 top-3 text-stone-400 pointer-events-none" />
                {isIndustryOpen && (
                  <div
                    id="client-industry-options"
                    role="listbox"
                    className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl py-1 shadow-xl"
                    style={{
                      background: 'rgb(18, 16, 24)',
                      border: '1px solid var(--border-soft)',
                    }}
                  >
                    {INDUSTRY_OPTIONS.map((option, index) => (
                      <button
                        key={option}
                        id={`client-industry-option-${index}`}
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
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Phone Number
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="e.g. +966 5X XXX XXXX"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{
                  background: 'rgba(10, 10, 13, 0.8)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--white)',
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Total Contract Value
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  value={dueValue}
                  onChange={(e) => setDueValue(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="e.g. 60000"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
              <p className="text-[11px] text-stone-400 mt-1">
                The primary value of this engagement.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Contract Start Date
              </label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    const newStart = e.target.value;
                    setStartDate(newStart);
                    if (!renewalDateTouched) {
                      setRenewalDate(
                        contractDurationMonths === ''
                          ? addOneYear(newStart)
                          : addMonths(newStart, Number(contractDurationMonths))
                      );
                    }
                  }}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Monthly Retainer (USD/SAR) (optional)
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  value={contractValue}
                  onChange={(e) => setContractValue(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="e.g. 5000"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Contract Duration (months)
              </label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  min={1}
                  value={contractDurationMonths}
                  onChange={(e) => {
                    const value = e.target.value === '' ? '' : Number(e.target.value);
                    setContractDurationMonths(value);
                    if (!renewalDateTouched) {
                      setRenewalDate(value === '' ? addOneYear(startDate) : addMonths(startDate, Number(value)));
                    }
                  }}
                  placeholder="e.g. 12"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Remaining Amount (optional)
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="number"
                  value={remainingValue}
                  onChange={(e) => setRemainingValue(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="e.g. 60000"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Renewal Date
              </label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="date"
                  value={renewalDate}
                  onChange={(e) => {
                    setRenewalDate(e.target.value);
                    setRenewalDateTouched(true);
                  }}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                  style={{
                    background: 'rgba(10, 10, 13, 0.8)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                />
              </div>
              <p className="text-[11px] text-stone-400 mt-1">
                Auto-calculated from Start Date + Contract Duration (or one year, if duration is
                left blank). Adjust if needed.
              </p>
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
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Additional Services
            </label>
            <p className="text-[11px] text-stone-400 mb-1.5">
              Optional add-ons — independent of شاملة and every other service above.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {CLIENT_SERVICE_OPTIONS.filter((opt) => opt.group === 'additional').map((opt) => {
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
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Signed Contract <span className="text-red-400">*</span>
            </label>
            <input
              ref={contractFileInputRef}
              type="file"
              onChange={handleContractFileSelect}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => contractFileInputRef.current?.click()}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm transition-all"
              style={{
                background: 'rgba(10, 10, 13, 0.9)',
                border: contractFile ? '1px solid var(--purple)' : '1px solid var(--border-soft)',
                color: contractFile ? 'var(--purple-light)' : 'var(--grey)',
              }}
            >
              <FileSignature className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {contractFile ? contractFile.name : 'Upload the signed contract (PDF, Word, or scanned image)...'}
              </span>
            </button>
            {contractFileError && <p className="text-[11px] text-red-400 mt-1">{contractFileError}</p>}
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Notes (optional)
            </label>
            <div className="relative">
              <StickyNote className="w-4 h-4 absolute left-3 top-3 text-purple-400 pointer-events-none" />
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any extra info about this client..."
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400"
                style={{
                  background: 'rgba(10, 10, 13, 0.9)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--white)',
                }}
              />
            </div>
          </div>

          {/* Assign / Transfer to AM Team Leader — Sales/AM Agent never pick this manually; it's
              auto-resolved on submit (see soleActiveAmTeamLeadId above) and this field is simply
              hidden for them. */}
          {isManagementForm && (
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                {isAmForm ? 'Account Management Lead' : 'Route to Account Management Lead'}
              </label>
              <div className="relative">
                <Users className="w-4 h-4 absolute left-3 top-3 text-purple-400 pointer-events-none" />
                <select
                  value={amTeamLeadId}
                  onChange={(e) => setAmTeamLeadId(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm transition-all focus:outline-none focus:ring-1 focus:ring-purple-400 cursor-pointer"
                  style={{
                    background: 'rgba(10, 10, 13, 0.9)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--white)',
                  }}
                >
                  <option value="" className="bg-stone-900 text-white">-- Unassigned --</option>
                  {amTeamLeaders.map((leader) => (
                    <option key={leader.id} value={leader.id} className="bg-stone-900 text-white">
                      {leader.name} — ({leader.team || 'Account Management Lead'})
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-stone-400 mt-1">
                {isAmForm
                  ? 'The team lead of record for this client.'
                  : 'Client record will be routed to AM lead for account assignment and service kickoff.'}
              </p>
            </div>
          )}

          {isManagementForm && (
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>Account Manager (optional)</label>
              <select value={amAgentId} onChange={(e) => setAmAgentId(e.target.value)} className="w-full px-3 py-2.5 rounded-xl text-sm bg-stone-950 text-white border border-purple-900/40">
                <option value="">-- Unassigned --</option>
                {amTeamLeaders.map((leader) => (
                  <option key={leader.id} value={leader.id}>{leader.name} (Team Leader)</option>
                ))}
                {amAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
              <p className="text-[11px] text-stone-400 mt-1">
                The person actually responsible for this account's day-to-day work — an AM Team
                Leader can self-assign here instead of delegating to an Agent.
              </p>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium transition-colors"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                color: 'var(--grey)',
                border: '1px solid var(--border-soft)',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-2"
              style={{
                background: 'var(--gradient-badge)',
                color: 'var(--white)',
                border: '1px solid var(--border-strong)',
                opacity: isSubmitting ? 0.7 : 1,
              }}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isSubmitting ? 'Registering...' : 'Register Client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
