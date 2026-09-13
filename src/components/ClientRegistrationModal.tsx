import React, { useState } from 'react';
import { X, UserCheck, Sparkles, Building2, Briefcase, DollarSign, Calendar, Users, Phone, Layers } from 'lucide-react';
import { ServiceType, UserRecord } from '../types/database';

const SERVICE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: 'seo', label: 'SEO' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'media_buying', label: 'Media Buying' },
  { value: 'creative', label: 'Creative' },
];

interface ClientRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  amTeamLeaders?: UserRecord[];
  onSubmit: (clientData: {
    name: string;
    industry: string;
    services: ServiceType[];
    phone_number?: string;
    contract_value: number;
    start_date: string;
    renewal_date: string;
    am_team_lead_id?: string;
  }) => Promise<void>;
}

const addOneYear = (dateStr: string): string => {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
};

export const ClientRegistrationModal: React.FC<ClientRegistrationModalProps> = ({
  isOpen,
  onClose,
  amTeamLeaders = [],
  onSubmit,
}) => {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedServices, setSelectedServices] = useState<ServiceType[]>([]);
  const [contractValue, setContractValue] = useState<number | ''>('');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [renewalDate, setRenewalDate] = useState(addOneYear(new Date().toISOString().split('T')[0]));
  const [renewalDateTouched, setRenewalDateTouched] = useState(false);
  const [amTeamLeadId, setAmTeamLeadId] = useState(amTeamLeaders[0]?.id || 'usr-am-lead');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Please enter the client / company name.');
      return;
    }
    if (selectedServices.length === 0) {
      setErrorMsg('Please select at least one service.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg('');
    try {
      await onSubmit({
        name: name.trim(),
        industry: industry.trim() || 'General',
        services: selectedServices,
        phone_number: phoneNumber.trim() || undefined,
        contract_value: contractValue ? Number(contractValue) : 0,
        start_date: startDate,
        renewal_date: renewalDate,
        am_team_lead_id: amTeamLeadId,
      });
      // reset
      setName('');
      setIndustry('');
      setPhoneNumber('');
      setSelectedServices([]);
      setContractValue('');
      setRenewalDateTouched(false);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error registering client');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleService = (service: ServiceType) => {
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" dir="ltr">
      <div
        className="w-full max-w-xl rounded-[20px] p-6 shadow-2xl relative overflow-hidden font-sans"
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
                Client will be created and routed to Account Management to begin onboarding
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
                Industry / Sector
              </label>
              <div className="relative">
                <Briefcase className="w-4 h-4 absolute left-3 top-3 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. E-Commerce, Real Estate"
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
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
                Monthly Retainer (USD/SAR)
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
                      setRenewalDate(addOneYear(newStart));
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
              Defaults to one year from the contract start date. Adjust if needed.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Services <span className="text-red-400">*</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SERVICE_OPTIONS.map((opt) => {
                const isSelected = selectedServices.includes(opt.value);
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

          {/* Assign / Transfer to AM Team Leader */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--lilac)' }}>
              Route to Account Management Lead <span className="text-red-400">*</span>
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
                {amTeamLeaders.length > 0 ? (
                  amTeamLeaders.map((leader) => (
                    <option key={leader.id} value={leader.id} className="bg-stone-900 text-white">
                      {leader.name} — ({leader.team || 'Account Management Lead'})
                    </option>
                  ))
                ) : (
                  <option value="usr-am-lead" className="bg-stone-900 text-white">
                    Maha Al-Shami — AM Team Lead
                  </option>
                )}
              </select>
            </div>
            <p className="text-[11px] text-stone-400 mt-1">
              Client record will be routed to AM lead for account assignment and service kickoff.
            </p>
          </div>

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
